import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// Video of the vote count in one section on evideo.bg.
// One page per region: the first two digits of the section ID (e.g. "09" for 091500055).
const videoUrl = (sectionId) =>
    `https://evideo.bg/pvr2026/${sectionId.slice(0, 2)}.html#${sectionId}`;

const chartEl = document.getElementById("chart");
const tooltip = document.getElementById("tooltip");
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
    `Щракнете върху точка, за да отворите видеото от секцията в evideo.bg.`;

// Vertical jitter is fixed per section, so points do not move when the chart is redrawn.
const rand = d3.randomUniform.source(d3.randomLcg(42))(-0.3, 0.3);
for (const d of sections) d.jitter = rand();

let points = [];
let delaunay = null;
let highlight = null;
let shown = null; // section in the tooltip now
let lastPointerType = "mouse";

function render() {
    const width = chartEl.clientWidth;
    const narrow = width < 600;
    const margin = { top: 10, right: 16, bottom: 48, left: narrow ? 110 : 160 };
    const rowHeight = narrow ? 36 : 48;
    const height = margin.top + margin.bottom + rowHeight * regions.length;

    const x = d3.scaleLinear([0, 1], [margin.left, width - margin.right]);
    const y = d3
        .scaleBand(regions.map((r) => r.region), [margin.top, height - margin.bottom])
        .padding(0.15);

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
    svg.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
        .call((g) => g.select(".domain").remove());
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

    points = regions.flatMap((r) =>
        r.rows.map((d) => ({
            d,
            px: x(d.rate),
            py: y(r.region) + y.bandwidth() * (0.5 + d.jitter),
        })),
    );

    svg.append("g")
        .selectAll("circle")
        .data(points)
        .join("circle")
        .attr("class", (p) => `pt ${p.d.rate < 0.5 ? "blue" : "red"}`)
        .attr("cx", (p) => p.px)
        .attr("cy", (p) => p.py)
        .attr("r", narrow ? 1.8 : 2.5);

    const boxes = svg
        .append("g")
        .attr("class", "box")
        .selectAll("g")
        .data(regions)
        .join("g")
        .attr("transform", (r) => `translate(0,${y(r.region) + y.bandwidth() / 2})`);
    const half = y.bandwidth() * 0.3;
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

    highlight = svg.append("circle").attr("class", "highlight").attr("r", 6).style("display", "none");
    delaunay = d3.Delaunay.from(points, (p) => p.px, (p) => p.py);

    svg.on("pointermove", (event) => {
        lastPointerType = event.pointerType;
        const p = nearest(event);
        p ? show(p, event) : hide();
    })
        .on("pointerdown", (event) => (lastPointerType = event.pointerType))
        .on("pointerleave", hide)
        .on("click", (event) => {
            const p = nearest(event);
            if (!p) return hide();
            // On touch, the first tap shows the tooltip and the second tap opens the video.
            if (lastPointerType === "touch" && shown !== p.d) return show(p, event);
            window.open(videoUrl(p.d.id), "_blank", "noopener");
        });
}

function nearest(event) {
    const [mx, my] = d3.pointer(event);
    const p = points[delaunay.find(mx, my)];
    return p && Math.hypot(p.px - mx, p.py - my) <= 15 ? p : null;
}

function show(p, event) {
    const d = p.d;
    shown = d;
    highlight.attr("cx", p.px).attr("cy", p.py).style("display", null);
    chartEl.style.cursor = "pointer";

    const turnout = d.registered ? fmtPct(d.voted / d.registered) : "—";
    tooltip.innerHTML = `
        <div class="tooltip-title">Секция ${d.id}</div>
        <div class="muted">${esc(d.settlement)}, ${esc(d.municipality)} · ${esc(d.region)}</div>
        <div class="muted">${esc(d.address)}</div>
        <table>
            <tr><td><span class="swatch blue"></span>${esc(names.blue)}</td><td>${fmtInt(d.blue)}</td></tr>
            <tr><td><span class="swatch red"></span>${esc(names.red)}</td><td>${fmtInt(d.red)}</td></tr>
            <tr><td>Дял на ${esc(names.red)}</td><td><b>${fmtPct(d.rate)}</b></td></tr>
            <tr><td>Гласували / в списъка</td><td>${fmtInt(d.voted)} / ${fmtInt(d.registered)}</td></tr>
            <tr><td>Активност</td><td>${turnout}</td></tr>
        </table>
        <div class="tooltip-hint muted">${lastPointerType === "touch" ? "Докоснете отново" : "Щракнете"} за видео от секцията ↗</div>`;
    tooltip.hidden = false;

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

function hide() {
    shown = null;
    tooltip.hidden = true;
    highlight?.style("display", "none");
    chartEl.style.cursor = "";
}

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

render();
let lastWidth = chartEl.clientWidth;
new ResizeObserver(() => {
    if (chartEl.clientWidth === lastWidth) return;
    lastWidth = chartEl.clientWidth;
    hide();
    render();
}).observe(chartEl);
