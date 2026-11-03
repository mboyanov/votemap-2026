// Search box: section numbers, settlements, countries (abroad) and addresses.
// setupSearch() is called from results.js once the data is loaded.

const MAX_RESULTS = 8;

// Latin -> Cyrillic, so "Plovdiv" or "London" also work. Longer sequences first.
const LATIN = [
    ["sht", "щ"], ["zh", "ж"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"], ["yu", "ю"], ["ya", "я"], ["ia", "ия"],
    ["a", "а"], ["b", "б"], ["v", "в"], ["g", "г"], ["d", "д"], ["e", "е"], ["z", "з"], ["i", "и"], ["y", "й"],
    ["k", "к"], ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["r", "р"], ["s", "с"], ["t", "т"],
    ["u", "у"], ["f", "ф"], ["h", "х"], ["c", "к"], ["w", "в"], ["x", "кс"], ["q", "к"], ["j", "дж"],
];

function toCyrillic(text) {
    let out = "";
    for (let i = 0; i < text.length;) {
        const hit = LATIN.find(([lat]) => text.startsWith(lat, i));
        out += hit ? hit[1] : text[i];
        i += hit ? hit[0].length : 1;
    }
    return out;
}

function normalize(text) {
    return text.toLowerCase().replace(/["'„“”«».,()\-–\/№]/g, " ").replace(/\s+/g, " ").trim();
}

// "гр.София" -> "софия", "с.Липница" -> "липница"
function settlementName(name) {
    return normalize(name.replace(/^(гр|с|к|ман)\./i, ""));
}

function buildIndex(features) {
    const places = new Map();
    const countries = new Map();
    const buildings = [];
    const sections = [];

    function addTo(map, key, make, f) {
        if (!map.has(key)) map.set(key, { ...make(), coords: [], voted: 0 });
        const entry = map.get(key);
        entry.coords.push(f.geometry.coordinates);
        entry.voted += f.properties.voted;
    }

    for (const f of features) {
        const p = f.properties;
        addTo(places, p.place, () => ({
            kind: "place",
            label: p.settlement,
            detail: p.abroad ? p.municipality : "общ. " + p.municipality + ", обл. " + p.region,
            norm: settlementName(p.settlement),
        }), f);
        if (p.abroad) {
            addTo(countries, p.municipality, () => ({
                kind: "country",
                label: p.municipality,
                detail: "Извън страната",
                norm: normalize(p.municipality),
            }), f);
        }
        buildings.push({
            kind: "building",
            label: p.address,
            detail: p.settlement + (p.n_sections > 1 ? " · " + p.n_sections + " секции" : ""),
            norm: normalize(p.settlement + " " + p.address),
            bid: p.bid,
            coords: f.geometry.coordinates,
            voted: p.voted,
        });
        for (const s of p.sections) {
            sections.push({ kind: "section", label: "СИК " + s.id, detail: p.settlement + " · " + p.address, id: s.id, bid: p.bid, coords: f.geometry.coordinates });
        }
    }
    const byVoters = (a, b) => b.voted - a.voted;
    return {
        places: [...places.values()].sort(byVoters),
        countries: [...countries.values()].sort(byVoters),
        buildings: buildings.sort(byVoters),
        sections: sections.sort((a, b) => a.id.localeCompare(b.id)),
    };
}

function findMatches(index, query) {
    const q = normalize(query);
    if (!q) return [];
    // Section numbers: 3 or more digits, matched from the start.
    const digits = q.replace(/\s/g, "");
    if (/^\d{3,}$/.test(digits)) {
        return index.sections.filter(s => s.id.startsWith(digits)).slice(0, MAX_RESULTS);
    }
    const variants = [...new Set([q, toCyrillic(q)])];
    const starts = e => variants.some(v => e.norm.startsWith(v));
    const containsAll = e => variants.some(v => v.split(" ").every(token => e.norm.includes(token)));

    const out = [];
    const add = (list, test, limit) => {
        for (const e of list) {
            if (out.length >= limit) break;
            if (!out.includes(e) && test(e)) out.push(e);
        }
    };
    add(index.countries, starts, 2);
    add(index.places, starts, 5);
    add(index.places, containsAll, 5);
    add(index.buildings, containsAll, MAX_RESULTS);
    return out;
}

function setupSearch({ features, map, openBuilding, buildingZoom }) {
    const input = document.getElementById("search");
    const list = document.getElementById("search-results");
    const index = buildIndex(features);
    let matches = [];
    let active = -1;

    function render() {
        list.replaceChildren();
        const open = input.value.trim() !== "";
        list.hidden = !open;
        input.setAttribute("aria-expanded", String(open));
        if (!open) return;
        if (!matches.length) {
            const li = document.createElement("li");
            li.className = "search-empty";
            li.textContent = "Няма резултати";
            list.append(li);
            return;
        }
        matches.forEach((m, i) => {
            const li = document.createElement("li");
            li.id = "search-option-" + i;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", String(i === active));
            const label = document.createElement("div");
            label.className = "search-label";
            label.textContent = m.label;
            const detail = document.createElement("div");
            detail.className = "search-detail";
            detail.textContent = m.detail;
            li.append(label, detail);
            // mousedown, not click: it fires before the input loses focus and closes the list.
            li.addEventListener("mousedown", e => {
                e.preventDefault();
                select(m);
            });
            list.append(li);
        });
        input.setAttribute("aria-activedescendant", active >= 0 ? "search-option-" + active : "");
    }

    function select(m) {
        input.value = m.label;
        matches = [];
        active = -1;
        render();
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.blur();

        if (m.kind === "building" || m.kind === "section") {
            goToBuilding(m.bid, m.coords);
        } else if (m.coords.length === 1) {
            const f = features.find(f => f.geometry.coordinates === m.coords[0]);
            goToBuilding(f.properties.bid, m.coords[0]);
        } else {
            const bounds = new maplibregl.LngLatBounds(m.coords[0], m.coords[0]);
            for (const c of m.coords) bounds.extend(c);
            map.fitBounds(bounds, { padding: 60, maxZoom: buildingZoom });
        }
    }

    function goToBuilding(bid, coords) {
        map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), buildingZoom) });
        map.once("moveend", () => openBuilding(bid, coords));
    }

    input.addEventListener("input", () => {
        matches = findMatches(index, input.value);
        active = matches.length ? 0 : -1;
        render();
    });
    input.addEventListener("keydown", e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!matches.length) return;
            e.preventDefault();
            active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            render();
        } else if (e.key === "Enter" && matches.length) {
            e.preventDefault();
            select(matches[Math.max(0, active)]);
        } else if (e.key === "Escape") {
            input.value = "";
            matches = [];
            render();
        }
    });
    input.addEventListener("blur", () => {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
    });
    input.addEventListener("focus", () => {
        if (input.value.trim()) render();
    });
}
