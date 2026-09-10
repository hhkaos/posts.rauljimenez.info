/* ArcGIS Maps SDK for JavaScript map view for posts.rauljimenez.info.
   One file, two uses:
     - the /map/ overview: <arcgis-map id="map"> plus a
       <script type="application/json" id="map-points"> payload of every
       geotagged post, drawn as a clustered, labelled client-side
       FeatureLayer with a link popup;
     - a single-marker mini-map on each geotagged post page:
       <arcgis-map class="post-map__canvas" data-lat data-lon data-type>.

   Loaded as `type="module"` (via page()'s `head` slot) right after the SDK
   bootstrap `<script type="module" src="https://js.arcgis.com/5.1/">`, which
   registers the <arcgis-map> element and exposes the global `$arcgis`.

   Progressive enhancement: with no JS the <arcgis-map> stays empty and the
   openstreetmap.org link (mini-map) / the places list (/map/) are the
   fallback — both always in the HTML.

   Dark mode: ArcGIS draws the basemap and the data into a single WebGL
   canvas, so the old "invert just the tile layer" trick isn't possible.
   The basemap therefore stays light in dark mode; only the widget/popup
   chrome follows the theme (`.calcite-mode-dark` on the element). */

const OVERVIEW_ZOOM_CAP = 14;

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

// Marker colour per post type, read from the same CSS custom properties the
// timeline badges use, so map and timeline always match.
function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--" + name);
  return (v && v.trim()) || "#f05924";
}

// Keep the <arcgis-map> chrome (zoom control, popup, attribution) in step
// with the site's light/dark toggle.
function applyTheme(els) {
  const dark = isDark();
  els.forEach((el) => el.classList.toggle("calcite-mode-dark", dark));
}

function whenReady(el) {
  return new Promise((resolve) => {
    if (el.ready) return resolve();
    el.addEventListener("arcgisViewReadyChange", function handler() {
      if (!el.ready) return;
      el.removeEventListener("arcgisViewReadyChange", handler);
      resolve();
    });
  });
}

function getArcgis() {
  if (window.$arcgis) return Promise.resolve(window.$arcgis);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (window.$arcgis) {
        clearInterval(timer);
        resolve(window.$arcgis);
      }
    }, 50);
  });
}

async function main() {
  const overviewEl = document.getElementById("map");
  const miniEls = [].slice.call(
    document.querySelectorAll("arcgis-map.post-map__canvas"),
  );
  const allEls = (overviewEl ? [overviewEl] : []).concat(miniEls);
  if (!allEls.length) return;

  await customElements.whenDefined("arcgis-map");
  applyTheme(allEls);
  new MutationObserver(() => applyTheme(allEls)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const $a = await getArcgis();
  const [FeatureLayer, Graphic, Point, reactiveUtils] = await $a.import([
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/Graphic.js",
    "@arcgis/core/geometry/Point.js",
    "@arcgis/core/core/reactiveUtils.js",
  ]);

  const kit = { FeatureLayer, Graphic, Point, reactiveUtils };
  if (overviewEl) await buildOverview(overviewEl, kit);
  miniEls.forEach((el) => buildMini(el, kit));
}

// --- /map/ overview ----------------------------------------------------
async function buildOverview(el, { FeatureLayer, Graphic, Point }) {
  const node = document.getElementById("map-points");
  let points = [];
  try {
    points = JSON.parse(node.textContent) || [];
  } catch (e) {
    points = [];
  }
  points = points.filter((p) => isFinite(p.lat) && isFinite(p.lon));

  await whenReady(el);
  const view = el.view;
  view.constraints = { snapToZoom: false, minZoom: 2 };

  if (!points.length) {
    el.classList.add("is-ready");
    return;
  }

  const marker = (type) => ({
    type: "simple-marker",
    size: 9,
    color: cssColor(type),
    outline: { color: "#ffffff", width: 1.5 },
  });

  const types = Array.from(new Set(points.map((p) => p.type || "note")));
  const graphics = points.map(
    (p, i) =>
      new Graphic({
        geometry: new Point({ longitude: p.lon, latitude: p.lat }),
        attributes: {
          oid: i + 1,
          type: p.type || "note",
          badge: p.badge || p.type || "",
          title: p.title || "",
          url: p.url || "",
          place: p.place || "",
          thumb: p.thumb || "",
        },
      }),
  );

  const layer = new FeatureLayer({
    source: graphics,
    objectIdField: "oid",
    geometryType: "point",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "oid", type: "oid" },
      { name: "type", type: "string" },
      { name: "badge", type: "string" },
      { name: "title", type: "string" },
      { name: "url", type: "string" },
      { name: "place", type: "string" },
      { name: "thumb", type: "string" },
    ],
    renderer: {
      type: "unique-value",
      field: "type",
      defaultSymbol: marker("note"),
      uniqueValueInfos: types.map((t) => ({ value: t, symbol: marker(t) })),
    },
    // Per-feature name labels — shown for any point that isn't rolled into
    // a cluster (cluster labels, below, take over when it is).
    labelingInfo: [
      {
        labelPlacement: "above-center",
        // Keep the zoomed-out view to markers + cluster counts only; names
        // appear from ~zoom 6 in, where they don't collide with clusters.
        minScale: 2000000,
        // Text() coercion is required — a bare `$feature.title` renders empty.
        labelExpressionInfo: { expression: "Text($feature.title)" },
        symbol: {
          type: "text",
          color: isDark() ? "#ececec" : "#1b1b1b",
          haloColor: isDark() ? "#161616" : "#ffffff",
          haloSize: 1.4,
          font: { size: 10, weight: "bold" },
        },
      },
    ],
    popupTemplate: {
      title: "{badge}",
      outFields: ["*"],
      // A content function returning a DOM node — inline styles, not
      // classes, because the SDK reparents/sanitises popup markup and
      // drops class hooks.
      content: (feature) => {
        const a = feature.graphic.attributes;
        const wrap = document.createElement("div");
        wrap.className = "map-pop";
        wrap.style.cssText = "line-height:1.4";
        if (a.thumb) {
          const img = document.createElement("img");
          img.src = a.thumb;
          img.alt = "";
          img.style.cssText =
            "display:block;width:100%;max-height:130px;object-fit:cover;border-radius:6px;margin-bottom:.4rem";
          wrap.appendChild(img);
        }
        const link = document.createElement("a");
        link.href = a.url;
        link.textContent = a.title;
        link.style.cssText = "display:block;font-weight:600";
        wrap.appendChild(link);
        if (a.place) {
          const place = document.createElement("div");
          place.textContent = a.place;
          place.style.cssText = "margin-top:.2rem;font-size:.85rem;opacity:.75";
          wrap.appendChild(place);
        }
        return wrap;
      },
    },
    featureReduction: {
      type: "cluster",
      clusterRadius: "70px",
      clusterMinSize: "22px",
      clusterMaxSize: "56px",
      popupEnabled: true,
      popupTemplate: {
        title: "{cluster_count} posts",
        content:
          "There are {cluster_count} geotagged posts in this area. Zoom in to break the cluster apart.",
        fieldInfos: [
          {
            fieldName: "cluster_count",
            format: { places: 0, digitSeparator: true },
          },
        ],
      },
      labelingInfo: [
        {
          deconflictionStrategy: "none",
          labelPlacement: "center-center",
          labelExpressionInfo: {
            expression: "Text($feature.cluster_count, '#,###')",
          },
          symbol: {
            type: "text",
            color: "#ffffff",
            haloColor: cssColor("accent"),
            haloSize: 0.7,
            font: { size: 11, weight: "bold" },
          },
        },
      ],
    },
  });

  el.map.add(layer);
  await layer.when();

  try {
    const { extent } = await layer.queryExtent();
    if (extent) {
      await view.goTo(extent.expand(1.3), { animate: false });
      if (view.zoom > OVERVIEW_ZOOM_CAP) view.zoom = OVERVIEW_ZOOM_CAP;
    }
  } catch (e) {
    /* keep the element's default center/zoom */
  }
  el.classList.add("is-ready");
}

// --- per-post mini-maps ------------------------------------------------
async function buildMini(el, { Graphic, Point, reactiveUtils }) {
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);
  const fig = el.closest(".post-map");
  if (!isFinite(lat) || !isFinite(lon)) return;

  await whenReady(el);
  const view = el.view;
  view.constraints = { snapToZoom: false };

  view.graphics.add(
    new Graphic({
      geometry: new Point({ longitude: lon, latitude: lat }),
      symbol: {
        type: "simple-marker",
        size: 11,
        color: cssColor(el.dataset.type || "checkin"),
        outline: { color: "#ffffff", width: 2 },
      },
    }),
  );

  // Tell screenshot.mjs the map has drawn and settled.
  reactiveUtils
    .whenOnce(() => view.ready && !view.updating)
    .then(() => {
      if (fig) {
        fig.classList.add("is-ready");
        fig.dispatchEvent(new Event("post-map-ready"));
      }
      window.__postMapsReady = (window.__postMapsReady || 0) + 1;
    });
}

main().catch((err) => {
  // A map failure must never take the page down — the fallbacks stand.
  if (window && window.console) console.warn("map.js:", err);
});
