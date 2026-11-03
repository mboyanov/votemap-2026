const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [25.3, 42.7],
    zoom: 6.5,
});
map.addControl(new maplibregl.NavigationControl());

map.on('load', function () {
    map.addSource("locations", { type: "geojson", data: "locations.geojson", cluster: true, clusterMaxZoom: 12, clusterRadius: 40, clusterProperties: { sections: ["+", ["get", "n_sections"]] } })

    // Clusters: size and colour grow with the number of sections, not buildings.
    map.addLayer({
        id: "clusters",
        type: "circle",
        source: "locations",
        filter: ["has", "point_count"],
        paint: {
            "circle-color": ["step", ["get", "sections"], "#74c0fc", 50, "#339af0", 250, "#1971c2"],
            "circle-radius": ["step", ["get", "sections"], 14, 50, 20, 250, 28],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
        },
    });

    map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "locations",
        filter: ["has", "point_count"],
        layout: {
            "text-field": ["get", "sections"],
            "text-font": ["Noto Sans Bold"],
            "text-size": 12,
        },
        paint: {
            "text-color": "#ffffff",
        },
    });

    // Single buildings: radius grows with the number of sections inside.
    map.addLayer({
        id: "points",
        type: "circle",
        source: "locations",
        filter: ["!", ["has", "point_count"]],
        paint: {
            "circle-color": ["case", ["get", "abroad"], "#d9480f", "#1c7ed6"],
            "circle-radius": ["interpolate", ["linear"], ["get", "n_sections"], 1, 4, 15, 12],
            "circle-stroke-width": 1,
            "circle-stroke-color": "#ffffff",
        },
    });

    // Click a cluster: zoom in until it splits.
    map.on("click", "clusters", async function (e) {
        const feature = e.features[0];
        const zoom = await map.getSource("locations").getClusterExpansionZoom(feature.properties.cluster_id);
        map.easeTo({ center: feature.geometry.coordinates, zoom: zoom });
    });

    // Click a building: show its address and sections.
    map.on("click", "points", function (e) {
        const feature = e.features[0];
        const coordinates = feature.geometry.coordinates.slice();
        // When the map shows several copies of the world, open the popup on the copy that was clicked.
        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
            coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }
        new maplibregl.Popup({ maxWidth: "320px" })
            .setLngLat(coordinates)
            .setDOMContent(popupContent(feature.properties))
            .addTo(map);
    });

    for (const layer of ["clusters", "points"]) {
        map.on("mouseenter", layer, function () { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, function () { map.getCanvas().style.cursor = ""; });
    }
})

// Build the popup with textContent: addresses come from the CIK file, so never insert them as HTML.
function popupContent(props) {
    const root = document.createElement("div");
    root.className = "popup";

    const address = document.createElement("div");
    address.className = "popup-address";
    address.textContent = props.address;

    const meta = document.createElement("div");
    meta.className = "popup-meta";
    const sectionWord = props.n_sections === 1 ? "секция" : "секции";
    meta.textContent = (props.abroad ? "Извън страната" : "РИК " + props.rik) + " · " + props.n_sections + " " + sectionWord;

    const sections = document.createElement("div");
    sections.className = "popup-sections";
    sections.textContent = props.sections.split(",").join(", ");

    root.append(address, meta, sections);
    return root;
}