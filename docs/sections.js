import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// Video of the vote count in one section on evideo.bg.
// One page per region: the first two digits of the section ID (e.g. "09" for 091500055).
const videoUrl = (sectionId) =>
    `https://evideo.bg/pvr2026/${sectionId.slice(0, 2)}.html#${sectionId}`;

const chartEl = document.getElementById("chart");
const tooltip = document.getElementById("tooltip");
const sheet = document.getElementById("sheet");
const sheetBody = document.getElementById("sheet-body");
const sheetLink = document.getElementById("sheet-link");
const regionSelect = document.getElementById("region");
const fmtInt = d3.format(",");
const fmtPct = (v) => (v * 100).toFixed(1).replace(".", ",") + "%";

// "Илияна Малинова Йотова и Кирил ..." -> "Илияна Йотова"
function shortName(ticket) {
    const parts = ticket.split(" и ")[0].trim().split(/\s+/);
    return `${parts[0]} ${parts[parts.length - 1]}`;
}

const fc = await d3.json("results.geojson");
const names = { blue: shortName(fc.candidates.blue), red: shortName(fc.candidates.red) };
document.getElementById("name-blue").textContent = names.blue;
document.getElementById("name-red").textContent = names.red;

// One record per section. Building-level fields (address, region, ...) are copied to each section.
const sections = fc.features.flatMap(({ properties: b }) =>
    b.sections
        .filter((s) => s.blue + s.red > 0)
        .map((s) => ({
            ...s,
            rate: s.red / (s.blue + s.red),
            region: b.region,
            municipality: b.municipality,
            settlement: b.settlement,
            address: b.address,
        })),
);

// Box-and-whisker statistics per region (whiskers at 1.5 IQR, as in matplotlib).
const regions = d3
    .groups(sections, (d) => d.region)
    .map(([region, rows]) => {
        const v = rows.map((d) => d.rate).sort(d3.ascending);
        const q1 = d3.quantile(v, 0.25);
        const median = d3.quantile(v, 0.5);
        const q3 = d3.quantile(v, 0.75);
        const iqr = q3 - q1;
        return {
            region,
            rows,
            q1,
            median,
            q3,
            lo: d3.min(v.filter((x) => x >= q1 - 1.5 * iqr)),
            hi: d3.max(v.filter((x) => x <= q3 + 1.5 * iqr)),
        };
    })
    .sort((a, b) => d3.ascending(a.median, b.median));

document.getElementById("subtitle").textContent =
    `Всяка точка е една секция (${fmtInt(sections.length)}). ` +
    `Ос X: дял на ${names.red} от гласовете за двамата кандидати. ` +
    `Без ${fmtInt(fc.excluded.sections)} подвижни секции без координати. ` +
    `Изберете точка, за да отворите видеото от секцията в evideo.bg.`;

for (const r of regions) regionSelect.add(new Option(r.region, r.region));
regionSelect.addEventListener("change", () => setRegion(regionSelect.value));

// Vertical jitter is fixed per section, so points do not move when the chart is redrawn.
const rand = d3.randomUniform.source(d3.randomLcg(42))(-0.3, 0.3);
for (const d of sections) d.jitter = rand();

let points = [];
let delaunay = null;
let highlight = null;
let selected = null; // section in the tooltip or the bottom panel now
let lastPointerType = "mouse";
let focusRegion = ""; // "" = all regions

function setRegion(region) {
    focusRegion = region;
    regionSelect.value = region;
    hide();
    render();
    if (region) chartEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function render() {
    const width = chartEl.clientWidth;
    const narrow = width < 600;
    const shownRegions = focusRegion ? regions.filter((r) => r.region === focusRegion) : regions;
    const single = shownRegions.length === 1;

    const margin = single
        ? { top: 10, right: 16, bottom: 48, left: 16 }
        : { top: 10, right: 16, bottom: 48, left: narrow ? 110 : 160 };
    // One region: use most of the screen height, so that the points spread out.
    const rowHeight = single ? Math.max(320, Math.round(window.innerHeight * 0.6)) : narrow ? 36 : 48;
    const height = margin.top + margin.bottom + rowHeight * shownRegions.length;

    const x = d3.scaleLinear([0, 1], [margin.left, width - margin.right]);
    const y = d3
        .scaleBand(shownRegions.map((r) => r.region), [margin.top, height - margin.bottom])
        .padding(single ? 0.02 : 0.15);

    chartEl.replaceChildren();
    const svg = d3
        .select(chartEl)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("role", "img")
        .attr("aria-label", "Дял на гласовете по секции, групирани по области");

    svg.append("g")
        .attr("transform", `translate(0,${height - margin.bottom})`)
        .call(d3.axisBottom(x).ticks(narrow ? 5 : 10, "%"));
    if (!single) {
        // Region names: tap or click one to show only that region.
        svg.append("g")
            .attr("class", "region-axis")
            .attr("transform", `translate(${margin.left},0)`)
            .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
            .call((g) => g.select(".domain").remove())
            .selectAll(".tick")
            .on("click", (event, region) => setRegion(region));
    }
    svg.append("text")
        .attr("x", (margin.left + width - margin.right) / 2)
        .attr("y", height - 8)
        .attr("text-anchor", "middle")
        .attr("fill", "currentColor")
        .text(`Дял на ${names.red} в секцията`);

    svg.append("line")
        .attr("class", "midline")
        .attr("x1", x(0.5))
        .attr("x2", x(0.5))
        .attr("y1", margin.top)
        .attr("y2", height - margin.bottom);

    points = shownRegions.flatMap((r) =>
        r.rows.map((d) => ({
            d,
            px: x(d.rate),
            // Jitter is ±0.3 of the row; one region gets ±0.45, so the points fill the tall row.
            py: y(r.region) + y.bandwidth() * (0.5 + d.jitter * (single ? 1.5 : 1)),
        })),
    );

    svg.append("g")
        .selectAll("circle")
        .data(points)
        .join("circle")
        .attr("class", (p) => `pt ${p.d.rate < 0.5 ? "blue" : "red"}`)
        .attr("cx", (p) => p.px)
        .attr("cy", (p) => p.py)
        .attr("r", single ? 3.5 : narrow ? 1.8 : 2.5);

    const boxes = svg
        .append("g")
        .attr("class", "box")
        .selectAll("g")
        .data(shownRegions)
        .join("g")
        .attr("transform", (r) => `translate(0,${y(r.region) + y.bandwidth() / 2})`);
    // In single-region mode the box stays small, so it does not hide the points.
    const half = single ? 14 : y.bandwidth() * 0.3;
    boxes.append("rect")
        .attr("x", (r) => x(r.q1))
        .attr("width", (r) => x(r.q3) - x(r.q1))
        .attr("y", -half)
        .attr("height", 2 * half);
    boxes.append("line")
        .attr("class", "median")
        .attr("x1", (r) => x(r.median))
        .attr("x2", (r) => x(r.median))
        .attr("y1", -half)
        .attr("y2", half);
    boxes.append("path").attr("d", (r) =>
        [
            `M${x(r.lo)},0H${x(r.q1)}`,
            `M${x(r.q3)},0H${x(r.hi)}`,
            `M${x(r.lo)},${-half / 2}V${half / 2}`,
            `M${x(r.hi)},${-half / 2}V${half / 2}`,
        ].join(""),
    );

    highlight = svg.append("circle").attr("class", "highlight").attr("r", 7).style("display", "none");
    delaunay = d3.Delaunay.from(points, (p) => p.px, (p) => p.py);

    svg.on("pointerdown", (event) => (lastPointerType = event.pointerType))
        .on("pointermove", (event) => {
            // Touch: no hover. A finger moving over the chart is scrolling.
            if (event.pointerType !== "mouse") return;
            lastPointerType = "mouse";
            const p = nearest(event, 15);
            p ? showTooltip(p, event) : hide();
        })
        .on("pointerleave", (event) => {
            if (event.pointerType === "mouse") hide();
        })
        .on("click", (event) => {
            if (lastPointerType === "mouse") {
                const p = nearest(event, 15);
                if (p) window.open(videoUrl(p.d.id), "_blank", "noopener");
                return;
            }
            // Touch and pen: a fingertip is wide, so look further for the nearest point.
            const p = nearest(event, 24);
            p ? showSheet(p) : hide();
        });
}

function nearest(event, radius) {
    const [mx, my] = d3.pointer(event);
    const p = points[delaunay.find(mx, my)];
    return p && Math.hypot(p.px - mx, p.py - my) <= radius ? p : null;
}

function sectionHtml(d) {
    const turnout = d.registered ? fmtPct(d.voted / d.registered) : "—";
    return `
        <div class="tooltip-title">Секция ${d.id}</div>
        <div class="muted">${esc(d.settlement)}, ${esc(d.municipality)} · ${esc(d.region)}</div>
        <div class="muted">${esc(d.address)}</div>
        <table>
            <tr><td><span class="swatch blue"></span>${esc(names.blue)}</td><td>${fmtInt(d.blue)}</td></tr>
            <tr><td><span class="swatch red"></span>${esc(names.red)}</td><td>${fmtInt(d.red)}</td></tr>
            <tr><td>Дял на ${esc(names.red)}</td><td><b>${fmtPct(d.rate)}</b></td></tr>
            <tr><td>Гласували / в списъка</td><td>${fmtInt(d.voted)} / ${fmtInt(d.registered)}</td></tr>
            <tr><td>Активност</td><td>${turnout}</td></tr>
        </table>`;
}

function select(p) {
    selected = p.d;
    highlight.attr("cx", p.px).attr("cy", p.py).style("display", null);
}

function showTooltip(p, event) {
    if (selected !== p.d) {
        select(p);
        tooltip.innerHTML = sectionHtml(p.d) + `<div class="tooltip-hint muted">Щракнете за видео от секцията ↗</div>`;
    }
    tooltip.hidden = false;
    chartEl.style.cursor = "pointer";

    // Keep the tooltip inside the window: flip it to the other side of the cursor near an edge.
    const gap = 14;
    const { width: tw, height: th } = tooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + tw > window.innerWidth - 8) left = Math.max(8, event.clientX - gap - tw);
    if (top + th > window.innerHeight - 8) top = Math.max(8, event.clientY - gap - th);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

function showSheet(p) {
    select(p);
    sheetBody.innerHTML = sectionHtml(p.d);
    sheetLink.href = videoUrl(p.d.id);
    sheet.hidden = false;
    // Leave room below the chart, so the panel never hides the last rows.
    document.body.style.paddingBottom = `${sheet.offsetHeight}px`;
}

function hide() {
    selected = null;
    tooltip.hidden = true;
    sheet.hidden = true;
    document.body.style.paddingBottom = "";
    highlight?.style("display", "none");
    chartEl.style.cursor = "";
}

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

document.getElementById("sheet-close").addEventListener("click", hide);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
});

render();
let lastWidth = chartEl.clientWidth;
new ResizeObserver(() => {
    if (chartEl.clientWidth === lastWidth) return;
    lastWidth = chartEl.clientWidth;
    hide();
    render();
}).observe(chartEl);
