/* Leaflet maps for posts.rauljimenez.info. Two uses, one file:
     - the /map/ overview: #map plus a <script type="application/json"
       id="map-points"> payload of every geotagged post;
     - a single-marker mini-map on each geotagged post page: .post-map[data-lat].
   Tiles are OpenStreetMap. Dark mode is done in CSS (a filter on the tile
   layer — see style.css), so there's nothing theme-related here.
   Progressive enhancement: without this script the .post-map is just a
   link to openstreetmap.org and /map/ shows its list of places. Loaded
   with `defer`, after Leaflet, only on pages that have a map. */
(function () {
  "use strict";
  if (typeof L === "undefined") return;

  var lang = document.documentElement.dataset.lang === "es" ? "es" : "en";
  var STR = {
    en: { osm: "OpenStreetMap contributors" },
    es: { osm: "colaboradores de OpenStreetMap" },
  }[lang];

  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var ATTRIB =
    '&copy; <a href="https://www.openstreetmap.org/copyright">' + STR.osm + "</a>";

  function addTiles(map) {
    L.tileLayer(TILE_URL, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
  }

  // Marker colour per post type, read from the same CSS custom properties
  // the timeline badges use, so the two always match.
  function colorFor(type) {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--" + type);
    return (v && v.trim()) || "#f05924";
  }
  function marker(type, latlng, radius) {
    return L.circleMarker(latlng, {
      radius: radius || 7,
      weight: 2,
      color: "#ffffff",
      fillColor: colorFor(type),
      fillOpacity: 1,
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // --- /map/ overview ----------------------------------------------------
  var host = document.getElementById("map");
  var payload = document.getElementById("map-points");
  if (host && payload) {
    var points = [];
    try {
      points = JSON.parse(payload.textContent) || [];
    } catch (e) {
      points = [];
    }
    host.textContent = ""; // drop the <noscript> fallback now JS is running
    var overview = L.map(host, { scrollWheelZoom: false });
    addTiles(overview);

    var bounds = [];
    points.forEach(function (p) {
      if (!isFinite(p.lat) || !isFinite(p.lon)) return;
      bounds.push([p.lat, p.lon]);
      var popup =
        '<span class="map-pop__badge badge ' + esc(p.type) + '">' + esc(p.badge) + "</span>" +
        (p.thumb ? '<img class="map-pop__thumb" src="' + esc(p.thumb) + '" alt="">' : "") +
        '<a class="map-pop__title" href="' + esc(p.url) + '">' + esc(p.title) + "</a>" +
        (p.place ? '<span class="map-pop__place">' + esc(p.place) + "</span>" : "");
      marker(p.type, [p.lat, p.lon]).addTo(overview).bindPopup(popup, { className: "map-pop" });
    });

    if (bounds.length) overview.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    else overview.setView([25, 0], 1);
    host.classList.add("is-ready");
  }

  // --- per-post mini-maps ----------------------------------------------
  [].forEach.call(document.querySelectorAll(".post-map"), function (el) {
    var lat = parseFloat(el.dataset.lat);
    var lon = parseFloat(el.dataset.lon);
    if (!isFinite(lat) || !isFinite(lon)) return;

    var canvas = document.createElement("div");
    canvas.className = "post-map__canvas";
    el.insertBefore(canvas, el.firstChild);

    var mini = L.map(canvas, { scrollWheelZoom: false }).setView([lat, lon], 14);
    addTiles(mini);
    marker(el.dataset.type || "checkin", [lat, lon], 9).addTo(mini);
    el.classList.add("is-ready");
    // Leaflet mis-sizes a map created before layout settles.
    setTimeout(function () {
      mini.invalidateSize();
    }, 0);
  });
})();
