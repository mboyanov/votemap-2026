const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;

// Diverging blue (candidate 4) <-> red (candidate 25) with a neutral grey midpoint.
// In dark mode the arms get lighter towards the poles, so strong results stand out from the dark basemap.
const RAMP = dark
    ? { red2: "#ff8a87", red1: "#c23b3b", mid: "#6b6a65", blue1: "#2a78d6", blue2: "#86b6ef" }
    : { red2: "#9e2a2b", red1: "#e34948", mid: "#bab8b2", blue1: "#2a78d6", blue2: "#184f95" };
const NO_DATA = dark ? "#3a3a38" : "#e2e1dc";
const RAMP_TICKS = [0.1, 0.3, 0.5, 0.7, 0.9];

// Two colour modes:
// "diverging": blue <-> grey <-> red scale.
// "mix": each candidate's share drives its own RGB channel, full at 50%: 25% -> 127, 75% -> 255.
// Share for the blue candidate, calculated from the vote counts. Buildings and clusters both carry
// "blue" and "red" (clusters as sums, see clusterProperties), so one expression serves both.
const TWO_CANDIDATE_VOTES = ["+", ["get", "blue"], ["get", "red"]];
const SHARE_BLUE = ["/", ["get", "blue"], TWO_CANDIDATE_VOTES];

const COLOR_MODES = {
    diverging: {
        expression: () => ["interpolate-lab", ["linear"], SHARE_BLUE,
            0.1, RAMP.red2, 0.3, RAMP.red1, 0.5, RAMP.mid, 0.7, RAMP.blue1, 0.9, RAMP.blue2],
        color: share => interpolateRamp(share),
        poles: { blue: RAMP.blue2, red: RAMP.red2 },
    },
    mix: {
        expression: () => {
            const share = SHARE_BLUE;
            const channel = s => ["min", 255, ["floor", ["*", 510, s]]];
            return ["rgb", channel(["-", 1, share]), 0, channel(share)];
        },
        color: share => {
            const channel = s => Math.min(255, Math.floor(510 * s));
            return "rgb(" + channel(1 - share) + ", 0, " + channel(share) + ")";
        },
        poles: { blue: "rgb(0, 0, 255)", red: "rgb(255, 0, 0)" },
    },
    // Pies are a separate symbol layer, not a circle colour; see addPieImages().
    pie: {
        poles: { blue: RAMP.blue1, red: RAMP.red1 },
    },
};

// Pie icons are drawn once at this radius (CSS px) and scaled down by icon-size, so they stay sharp.
const PIE_RADIUS = 48;

// Circle area is proportional to the number of voters: radius = k(zoom) * sqrt(voted).
const RADIUS_STOPS = [[5, 0.08], [10, 0.3], [15, 0.9]];
const RADIUS_BASE = 1.6;

// Buildings are grouped into clusters up to this zoom; above it every building is its own circle.
const CLUSTER_MAX_ZOOM = 12;
const SUMMED = ["registered", "voted", "blue", "red", "n_sections"];

// Same breakpoint as the CSS: on phones the legend is a bar at the top, on wider screens a panel at the bottom left.
const phone = window.matchMedia("(max-width: 640px)").matches;

const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/" + (dark ? "dark" : "positron"),
    // Start with all of Bulgaria in view, clear of the search box and the legend.
    bounds: [[22.36, 41.23], [28.61, 44.22]],
    fitBoundsOptions: {
        padding: phone
            ? { top: 120, bottom: 40, left: 10, right: 10 }
            : { top: 60, bottom: 30, left: 340, right: 60 },
    },
});
map.addControl(new maplibregl.NavigationControl());

map.on("load", async function () {
    const data = await (await fetch("results.geojson")).json();
    const names = { blue: shortName(data.candidates.blue) + " (4)", red: shortName(data.candidates.red) + " (25)" };
    renderLegend(data, names);

    // MapLibre turns the nested "sections" list into a string on queried features, so the popup reads it from here.
    const buildings = new Map(data.features.map(f => [f.properties.bid, f.properties]));

    map.addSource("results", {
        type: "geojson",
        data: data,
        cluster: true,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterRadius: 30,
        // Clusters get the same property names as buildings, so the paint expressions work for both.
        clusterProperties: Object.fromEntries(SUMMED.map(key => [key, ["+", ["get", key]]])),
    });

    map.addLayer({
        id: "sections",
        type: "circle",
        source: "results",
        layout: {
            // Small buildings are drawn on top of big ones, so they are not hidden.
            "circle-sort-key": ["-", 0, ["get", "voted"]],
        },
        paint: {
            "circle-color": colorExpression("diverging"),
            "circle-radius": radiusExpression(),
            "circle-opacity": 0.85,
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6, 0.3, 12, 1],
            "circle-stroke-color": dark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)",
        },
    });

    addPieImages();
    map.addLayer({
        id: "pies",
        type: "symbol",
        source: "results",
        layout: {
            visibility: "none",
            "icon-image": ["case",
                ["==", TWO_CANDIDATE_VOTES, 0], "pie-none",
                ["concat", "pie-", ["to-string", ["round", ["*", 100, SHARE_BLUE]]]]],
            "icon-size": radiusExpression(1 / PIE_RADIUS),
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["-", 0, ["get", "voted"]],
        },
        paint: {
            "icon-opacity": 0.9,
        },
    });

    // Hover shows a tooltip; a tap does the same on touch screens.
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "320px", offset: 8 });
    const source = map.getSource("results");
    let shown = null;
    async function showPopup(e) {
        const feature = e.features[0];
        const p = feature.properties;
        map.getCanvas().style.cursor = "pointer";
        // Rebuild only when the pointer moves to another circle; cluster IDs are unique per zoom level.
        const key = p.cluster ? "c" + p.cluster_id : "b" + p.bid;
        if (key === shown && popup.isOpen()) return;
        shown = key;
        popup.setLngLat(feature.geometry.coordinates);
        if (!p.cluster) {
            popup.setDOMContent(popupContent(buildings.get(p.bid), names)).addTo(map);
            return;
        }
        popup.setDOMContent(clusterContent(p, names, null)).addTo(map);
        const leaves = await source.getClusterLeaves(p.cluster_id, Infinity, 0);
        if (shown === key) popup.setDOMContent(clusterContent(p, names, topSettlements(leaves)));
    }
    function hidePopup() {
        popup.remove();
        shown = null;
    }
    // Click a cluster: zoom in until it splits. Click a building: show its popup (for touch screens).
    async function onClick(e) {
        const feature = e.features[0];
        if (!feature.properties.cluster) return showPopup(e);
        const zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id);
        map.easeTo({ center: feature.geometry.coordinates, zoom: zoom });
    }
    // Only one of the two layers is visible at a time; a hidden layer gets no events.
    for (const layer of ["sections", "pies"]) {
        map.on("mousemove", layer, showPopup);
        map.on("mouseleave", layer, function () {
            map.getCanvas().style.cursor = "";
            hidePopup();
        });
        map.on("click", layer, onClick);
    }
    // Clusters are rebuilt at every zoom level, so a cluster popup would point at a group that no longer exists.
    map.on("zoomstart", hidePopup);

    setupSearch({
        features: data.features,
        map: map,
        // Zoom past the cluster limit, so the building is its own circle when its popup opens.
        buildingZoom: CLUSTER_MAX_ZOOM + 3,
        openBuilding: function (bid, coords) {
            shown = "b" + bid;
            popup.setLngLat(coords).setDOMContent(popupContent(buildings.get(bid), names)).addTo(map);
        },
    });

    map.on("zoom", renderSizeLegend);
    renderSizeLegend();

    for (const input of document.querySelectorAll("input[name=color-mode]")) {
        input.addEventListener("change", () => setColorMode(input.value));
    }
    setColorMode(document.querySelector("input[name=color-mode]:checked").value);
});

function colorExpression(mode) {
    return ["case", ["==", TWO_CANDIDATE_VOTES, 0], NO_DATA, COLOR_MODES[mode].expression()];
}

let colorMode = "diverging";

function setColorMode(mode) {
    colorMode = mode;
    const pie = mode === "pie";
    map.setLayoutProperty("pies", "visibility", pie ? "visible" : "none");
    map.setLayoutProperty("sections", "visibility", pie ? "none" : "visible");
    const m = COLOR_MODES[mode];
    document.getElementById("swatch-blue").style.background = m.poles.blue;
    document.getElementById("swatch-red").style.background = m.poles.red;
    document.getElementById("ramp-scale").hidden = pie;
    document.getElementById("pie-note").hidden = !pie;
    if (pie) return;
    map.setPaintProperty("sections", "circle-color", colorExpression(mode));
    document.getElementById("ramp").style.background =
        "linear-gradient(to right, " + RAMP_TICKS.map(m.color).join(", ") + ")";
}

// One pie image per whole percent for the blue candidate, plus a grey one for "no votes".
// The blue slice starts at 12 o'clock and goes clockwise.
function addPieImages() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.ceil(2 * PIE_RADIUS * ratio);
    const r = size / 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const outline = dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.45)";
    const lineWidth = 2 * ratio;

    function draw(name, share) {
        ctx.clearRect(0, 0, size, size);
        ctx.beginPath();
        ctx.arc(r, r, r - lineWidth, 0, 2 * Math.PI);
        ctx.fillStyle = share === null ? NO_DATA : RAMP.red1;
        ctx.fill();
        if (share > 0) {
            const start = -Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(r, r);
            ctx.arc(r, r, r - lineWidth, start, start + 2 * Math.PI * share);
            ctx.closePath();
            ctx.fillStyle = RAMP.blue1;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(r, r, r - lineWidth, 0, 2 * Math.PI);
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = outline;
        ctx.stroke();
        map.addImage(name, ctx.getImageData(0, 0, size, size), { pixelRatio: ratio });
    }

    for (let pct = 0; pct <= 100; pct++) draw("pie-" + pct, pct / 100);
    draw("pie-none", null);
}

// JS copy of the diverging expression, for the legend. A CSS gradient between the stops is close enough.
function interpolateRamp(share) {
    const stops = [RAMP.red2, RAMP.red1, RAMP.mid, RAMP.blue1, RAMP.blue2];
    return stops[RAMP_TICKS.indexOf(share)];
}

// "scale" turns the radius into another unit: pies use 1 / PIE_RADIUS to get an icon-size.
function radiusExpression(scale = 1) {
    const stops = [];
    for (const [zoom, k] of RADIUS_STOPS) {
        stops.push(zoom, ["*", k * scale, ["sqrt", ["get", "voted"]]]);
    }
    return ["interpolate", ["exponential", RADIUS_BASE], ["zoom"], ...stops];
}

// The same curve as radiusExpression(), for the size legend.
function radiusAt(zoom, voted) {
    const s = RADIUS_STOPS;
    let k;
    if (zoom <= s[0][0]) k = s[0][1];
    else if (zoom >= s[s.length - 1][0]) k = s[s.length - 1][1];
    else {
        let i = 0;
        while (zoom > s[i + 1][0]) i++;
        const [z0, k0] = s[i], [z1, k1] = s[i + 1];
        const t = (Math.pow(RADIUS_BASE, zoom - z0) - 1) / (Math.pow(RADIUS_BASE, z1 - z0) - 1);
        k = k0 + t * (k1 - k0);
    }
    return k * Math.sqrt(voted);
}

// "Андрей Атанасов Гюров и Георги Димитров Кандев" -> "Андрей Гюров"
function shortName(full) {
    const parts = full.split(" и ")[0].split(" ");
    return parts[0] + " " + parts[parts.length - 1];
}

function fmt(n) {
    return n.toLocaleString("bg-BG");
}

function pct(part, whole) {
    return whole ? (100 * part / whole).toLocaleString("bg-BG", { maximumFractionDigits: 1 }) + "%" : "–";
}

function renderLegend(data, names) {
    let voted = 0, sections = 0;
    for (const f of data.features) {
        voted += f.properties.voted;
        sections += f.properties.n_sections;
    }
    document.getElementById("totals-count").textContent =
        "На картата: " + fmt(sections) + " секции в " + fmt(data.features.length) + " сгради, " + fmt(voted) + " гласували";
    const ex = data.excluded;
    document.getElementById("excluded-note").textContent = ex.sections
        ? fmt(ex.sections) + " подвижни секции (" + fmt(ex.voted) + " гласували) нямат координати и не са на картата."
        : "";
    document.getElementById("name-blue").textContent = names.blue;
    document.getElementById("name-red").textContent = names.red;
}

// Phones only: the legend opens and closes with a button, so it does not cover the map.
function setupLegendToggle() {
    const legend = document.getElementById("legend");
    const button = document.getElementById("legend-toggle");
    button.addEventListener("click", () => {
        const open = legend.classList.toggle("open");
        button.setAttribute("aria-expanded", String(open));
        button.textContent = open ? "Скрий" : "Легенда";
    });
}
setupLegendToggle();

function renderSizeLegend() {
    const zoom = map.getZoom();
    const root = document.getElementById("sizes");
    root.replaceChildren();
    for (const voted of [100, 500, 2000]) {
        const d = Math.max(2, 2 * radiusAt(zoom, voted));
        const fig = document.createElement("figure");
        const dot = document.createElement("span");
        dot.style.width = d + "px";
        dot.style.height = d + "px";
        fig.append(dot, fmt(voted));
        root.append(fig);
    }
}

// Built with textContent: addresses come from the CIK file, so never insert them as HTML.
function popupContent(p, names) {
    const root = document.createElement("div");
    root.className = "popup";

    const title = document.createElement("div");
    title.className = "popup-title";
    title.textContent = p.settlement + " · " +
        (p.n_sections === 1 ? "СИК " + p.sections[0].id : p.n_sections + " секции");

    const meta = document.createElement("div");
    meta.className = "popup-meta";
    meta.textContent = p.address;

    root.append(title, meta, ...resultRows(p, names));
    if (p.n_sections > 1) root.append(sectionTable(p.sections));
    return root;
}

// Clusters are screen-space groups, not real places, so the popup names the biggest settlements in them.
// "settlements" is null while the cluster's buildings are still loading.
function clusterContent(p, names, settlements) {
    const root = document.createElement("div");
    root.className = "popup";

    const title = document.createElement("div");
    title.className = "popup-title";
    title.textContent = "Група · " + fmt(p.point_count) + " сгради, " + fmt(p.n_sections) + " секции";

    const meta = document.createElement("div");
    meta.className = "popup-meta";
    if (!settlements) {
        meta.textContent = "Зареждане…";
    } else {
        meta.textContent = settlements.top.map(([name, voted]) => name + " (" + fmt(voted) + ")").join(", ") +
            (settlements.more ? " и още " + fmt(settlements.more) + " места" : "");
    }

    const hint = document.createElement("div");
    hint.className = "popup-meta";
    hint.textContent = "Кликнете, за да увеличите.";

    root.append(title, meta, ...resultRows(p, names), hint);
    return root;
}

function topSettlements(leaves) {
    const voted = new Map();
    for (const leaf of leaves) {
        const name = leaf.properties.settlement;
        voted.set(name, (voted.get(name) || 0) + leaf.properties.voted);
    }
    const sorted = [...voted].sort((a, b) => b[1] - a[1]);
    return { top: sorted.slice(0, 3), more: Math.max(0, sorted.length - 3) };
}

function resultRows(p, names) {
    const poles = COLOR_MODES[colorMode].poles;
    return [
        row("Гласували", fmt(p.voted) + (p.registered ? " от " + fmt(p.registered) + " (" + pct(p.voted, p.registered) + ")" : "")),
        row(names.blue, fmt(p.blue) + " · " + pct(p.blue, p.blue + p.red), poles.blue),
        row(names.red, fmt(p.red) + " · " + pct(p.red, p.blue + p.red), poles.red),
    ];
}

function sectionTable(sections) {
    const table = document.createElement("table");
    table.className = "popup-sections";
    const head = table.createTHead().insertRow();
    for (const label of ["СИК", "Гласували", "За 4"]) {
        const th = document.createElement("th");
        th.textContent = label;
        head.append(th);
    }
    const body = table.createTBody();
    for (const s of sections) {
        const tr = body.insertRow();
        tr.insertCell().textContent = s.id;
        tr.insertCell().textContent = fmt(s.voted);
        tr.insertCell().textContent = pct(s.blue, s.blue + s.red);
    }
    const wrap = document.createElement("div");
    wrap.className = "popup-sections-wrap";
    wrap.append(table);
    return wrap;
}

function row(label, value, color) {
    const el = document.createElement("div");
    el.className = "popup-row";
    const name = document.createElement("span");
    if (color) {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = color;
        name.append(sw);
    }
    name.append(label);
    const val = document.createElement("span");
    val.textContent = value;
    el.append(name, val);
    return el;
}
