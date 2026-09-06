/* Month-by-month navigator for /calendar/. Progressive enhancement:
   without this script the page shows every event's month stacked (rendered
   by render.mjs); with it, the stacked grids are hidden and one month is
   shown at a time with ‹ prev / next › / today controls. Any month grid is
   built on demand from the <script type="application/json" id="calendar-events">
   payload. Dependency-free, same spirit as map.js. Loaded with `defer`. */
(function () {
  "use strict";

  var wrap = document.querySelector(".cal-months");
  var payload = document.getElementById("calendar-events");
  if (!wrap || !payload) return;

  var raw;
  try {
    raw = JSON.parse(payload.textContent) || [];
  } catch (e) {
    return; // leave the static grids in place
  }

  var WD = {
    en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    es: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
  };
  var TZ = "Europe/Madrid";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Epoch day number from a "YYYY-MM-DD" string — comparison/iteration only.
  function dnum(s) {
    var p = String(s).split("-");
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function dparts(n) {
    var d = new Date(n * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  var midx = function (y, m) { return y * 12 + (m - 1); };
  function monthLabel(y, m, locale) {
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, {
      timeZone: "UTC", month: "long", year: "numeric",
    });
  }

  var events = raw
    .map(function (r) {
      var sn = dnum(r.s);
      var en = dnum(r.e);
      if (isNaN(sn)) return null;
      if (isNaN(en) || en < sn) en = sn;
      return {
        startNum: sn, endNum: en, type: r.type,
        title: r.title, plainTitle: r.plainTitle || r.title, url: r.url,
      };
    })
    .filter(Boolean);

  // Today, in the author's timezone (so it lines up with the server's idea
  // of "today" and — unlike a stale static page — reflects the real date).
  var todayNum;
  try {
    todayNum = dnum(new Date().toLocaleDateString("en-CA", { timeZone: TZ }));
  } catch (e) {
    todayNum = dnum(new Date().toISOString().slice(0, 10));
  }
  var t = dparts(todayNum);
  var todayIdx = midx(t.y, t.m);

  // Navigable range: from the earliest of (this month, first event) to the
  // latest of (this month, last event). Empty months inside are reachable;
  // beyond the ends the arrows disable.
  var loIdx = todayIdx, hiIdx = todayIdx;
  events.forEach(function (e) {
    var s = dparts(e.startNum), en = dparts(e.endNum);
    loIdx = Math.min(loIdx, midx(s.y, s.m));
    hiIdx = Math.max(hiIdx, midx(en.y, en.m));
  });

  function monthGrid(y, m) {
    var firstWd = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var weeks = Math.ceil((firstWd + days) / 7);
    var monthStart = dnum(
      y + "-" + String(m).padStart(2, "0") + "-01",
    );

    var head = ["en", "es"].map(function (l) {
      return '<tr class="i18n-' + l + '">' +
        WD[l].map(function (w) { return "<th scope=\"col\">" + w + "</th>"; }).join("") +
        "</tr>";
    }).join("");

    var rows = "";
    for (var w = 0; w < weeks; w++) {
      rows += "<tr>";
      for (var wd = 0; wd < 7; wd++) {
        var cell = monthStart + w * 7 + wd - firstWd;
        var cp = dparts(cell);
        var inMonth = cp.y === y && cp.m === m;
        var cls = "cal-day";
        if (!inMonth) cls += " cal-day--adj";
        if (cell === todayNum) cls += " cal-day--today";
        var chips = "";
        events.forEach(function (e) {
          if (cell < e.startNum || cell > e.endNum) return;
          var pos = e.startNum === e.endNum ? " is-single"
            : cell === e.startNum ? " is-start"
            : cell === e.endNum ? " is-end" : " is-mid";
          var lbl = cell === e.startNum || e.startNum === e.endNum
            ? "<span>" + esc(e.title) + "</span>"
            : '<span aria-hidden="true"></span>';
          chips += '<a class="cal-ev cal-ev--' + esc(e.type) + pos +
            '" href="' + esc(e.url) + '" title="' + esc(e.plainTitle) +
            '" aria-label="' + esc(e.plainTitle) + '">' + lbl + "</a>";
        });
        rows += '<td class="' + cls + '"' +
          (cell === todayNum ? ' aria-current="date"' : "") +
          '><span class="cal-day__n">' + cp.d + "</span>" +
          (chips ? '<div class="cal-day__evs">' + chips + "</div>" : "") +
          "</td>";
      }
      rows += "</tr>";
    }
    return '<table class="cal-grid"><thead>' + head + "</thead><tbody>" +
      rows + "</tbody></table>";
  }

  // --- build the UI -----------------------------------------------------
  [].forEach.call(wrap.querySelectorAll(".cal-month"), function (f) { f.hidden = true; });
  wrap.classList.add("is-interactive");

  var nav = document.createElement("div");
  nav.className = "cal-nav";
  nav.innerHTML =
    '<button type="button" class="cal-nav__btn" data-step="-1" aria-label="Previous month / mes anterior">‹</button>' +
    '<strong class="cal-nav__label" aria-live="polite"></strong>' +
    '<button type="button" class="cal-nav__btn" data-step="1" aria-label="Next month / mes siguiente">›</button>' +
    '<button type="button" class="cal-nav__today"><span class="i18n-en">Today</span><span class="i18n-es">Hoy</span></button>';

  var view = document.createElement("figure");
  view.className = "cal-month cal-month--live";

  wrap.insertBefore(nav, wrap.firstChild);
  wrap.insertBefore(view, nav.nextSibling);

  var cur = Math.min(Math.max(todayIdx, loIdx), hiIdx);

  function draw() {
    var y = Math.floor(cur / 12);
    var m = (cur % 12) + 1;
    nav.querySelector(".cal-nav__label").innerHTML =
      '<span class="i18n-en">' + esc(monthLabel(y, m, "en-GB")) + "</span>" +
      '<span class="i18n-es">' + esc(monthLabel(y, m, "es-ES")) + "</span>";
    view.innerHTML = monthGrid(y, m);
    var btns = nav.querySelectorAll(".cal-nav__btn");
    btns[0].disabled = cur <= loIdx;
    btns[1].disabled = cur >= hiIdx;
    nav.querySelector(".cal-nav__today").disabled = cur === todayIdx;
  }

  nav.addEventListener("click", function (ev) {
    var b = ev.target.closest("button");
    if (!b) return;
    if (b.classList.contains("cal-nav__today")) cur = Math.min(Math.max(todayIdx, loIdx), hiIdx);
    else cur = Math.min(Math.max(cur + Number(b.dataset.step), loIdx), hiIdx);
    draw();
  });

  draw();
})();
