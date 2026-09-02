/*
 * webmentions.js — render the likes / reposts / replies / mentions that
 * webmention.io has collected for the current page.
 *
 * Framework-agnostic, zero dependencies, progressive enhancement. The page
 * ships:
 *   <link rel="canonical" href="…">                     (in <head>, the target)
 *   <section id="webmentions" hidden
 *            data-wm-api="https://webmention.io/api/mentions.jf2">
 *     <div id="webmentions-facepile" hidden></div>       likes/reposts/bookmarks
 *     <ol  id="webmentions-list"></ol>                    replies + mentions
 *   </section>
 * and loads this file with `defer`. The section stays hidden until there is
 * something to show, so a post with no responses renders nothing.
 *
 * Remote mention content is inserted with textContent only — never as HTML.
 *
 * Candidate shared module: the same job is done by a React component in
 * hhkaos/hhkaos.github.io and an inline copy in hhkaos/littlelink. See the
 * "unify the webmention widget" issue on hhkaos/littlelink.
 */
(function () {
  "use strict";

  var section = document.getElementById("webmentions");
  var facepileEl = document.getElementById("webmentions-facepile");
  var listEl = document.getElementById("webmentions-list");
  if (!section || !listEl || !window.fetch || !window.URL) return;

  var API = section.getAttribute("data-wm-api") || "https://webmention.io/api/mentions.jf2";
  var MAX_TEXT = 320;

  // --- target URLs -------------------------------------------------------
  // webmention.io matches the target exactly, so query both the trailing- and
  // non-trailing-slash form. `data-wm-targets` (space/comma separated) is an
  // optional override for pages without a self-referential canonical link.
  function targetUrls() {
    var explicit = section.getAttribute("data-wm-targets");
    var urls = explicit ? explicit.split(/[\s,]+/).filter(Boolean) : [];
    if (!urls.length) {
      var canon = document.querySelector('link[rel="canonical"]');
      urls = [(canon && canon.href) || location.href.split("#")[0].split("?")[0]];
    }
    var seen = {};
    urls.forEach(function (u) {
      seen[u] = true;
      seen[u.replace(/\/$/, "")] = true;
      if (!/\/$/.test(u)) seen[u + "/"] = true;
    });
    return Object.keys(seen);
  }

  // --- helpers ----------------------------------------------------------
  function clean(v) {
    return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  }

  function stripTags(html) {
    if (!html || !window.DOMParser) return "";
    try {
      return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
    } catch (e) {
      return "";
    }
  }

  function truncate(v) {
    var s = clean(v);
    if (s.length <= MAX_TEXT) return s;
    var cut = s.slice(0, MAX_TEXT - 1);
    var sp = cut.lastIndexOf(" ");
    if (sp > MAX_TEXT * 0.6) cut = cut.slice(0, sp);
    return cut + "…";
  }

  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function author(m) {
    var a = m.author || {};
    return {
      name: clean(a.name) || hostOf(m.url || m["wm-source"]) || "Someone",
      url: a.url || m.url || m["wm-source"] || "",
      photo: a.photo || ""
    };
  }

  function mentionText(m) {
    var c = m.content || {};
    return truncate(c.text || stripTags(c.html));
  }

  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "";
    var lang = document.documentElement.getAttribute("data-lang") === "es" ? "es" : "en";
    return d.toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
  }

  function bilingual(parent, en, es) {
    var a = document.createElement("span");
    a.className = "i18n-en";
    a.textContent = en;
    var b = document.createElement("span");
    b.className = "i18n-es";
    b.textContent = es;
    parent.appendChild(a);
    parent.appendChild(b);
  }

  function avatar(a, cls) {
    var el;
    if (a.photo) {
      el = document.createElement("img");
      el.src = a.photo;
      el.alt = "";
      el.loading = "lazy";
      el.width = 44;
      el.height = 44;
    } else {
      el = document.createElement("span");
      el.setAttribute("aria-hidden", "true");
      el.textContent = (a.name.charAt(0) || "?").toUpperCase();
    }
    el.className = cls;
    return el;
  }

  // --- render ----------------------------------------------------------
  var FACEPILE = {
    "like-of": { cls: "is-like", en: ["like", "likes"], es: ["me gusta", "me gusta"] },
    "repost-of": { cls: "is-repost", en: ["repost", "reposts"], es: ["compartido", "compartidos"] },
    "bookmark-of": { cls: "is-bookmark", en: ["bookmark", "bookmarks"], es: ["guardado", "guardados"] }
  };
  var THREAD = {
    "in-reply-to": { en: "replied", es: "respondió" },
    "mention-of": { en: "mentioned this", es: "lo mencionó" }
  };

  function renderFacepileGroup(prop, items) {
    var meta = FACEPILE[prop];
    var group = document.createElement("div");
    group.className = "webmentions__group " + meta.cls;

    var faces = document.createElement("div");
    faces.className = "webmentions__faces";
    var seen = {};
    items.forEach(function (m) {
      var a = author(m);
      var key = a.url || a.name;
      if (seen[key]) return;
      seen[key] = true;
      var link = document.createElement("a");
      link.href = m.url || m["wm-source"] || a.url || "#";
      link.rel = "nofollow noopener";
      link.target = "_blank";
      link.title = a.name;
      link.appendChild(avatar(a, "webmentions__face"));
      faces.appendChild(link);
    });
    group.appendChild(faces);

    var n = Object.keys(seen).length;
    var label = document.createElement("span");
    label.className = "webmentions__count";
    bilingual(
      label,
      n + " " + (n === 1 ? meta.en[0] : meta.en[1]),
      n + " " + (n === 1 ? meta.es[0] : meta.es[1])
    );
    group.appendChild(label);
    return group;
  }

  function renderThreadItem(m) {
    var a = author(m);
    var li = document.createElement("li");
    li.className = "webmentions__item h-cite";
    li.appendChild(avatar(a, "webmentions__avatar"));

    var body = document.createElement("div");
    body.className = "webmentions__body";

    var meta = document.createElement("p");
    meta.className = "webmentions__meta";

    var name = document.createElement("a");
    name.className = "webmentions__author p-author h-card u-url";
    name.href = a.url || "#";
    name.rel = "nofollow noopener";
    name.target = "_blank";
    name.textContent = a.name;
    meta.appendChild(name);

    var verb = THREAD[m["wm-property"]] || THREAD["mention-of"];
    meta.appendChild(document.createTextNode(" "));
    var verbEl = document.createElement("span");
    bilingual(verbEl, verb.en, verb.es);
    meta.appendChild(verbEl);

    var when = m.published || m["wm-received"];
    var date = fmtDate(when);
    if (date) {
      var time = document.createElement("time");
      time.className = "dt-published";
      time.dateTime = when;
      time.textContent = " · " + date;
      meta.appendChild(time);
    }
    body.appendChild(meta);

    var text = mentionText(m);
    if (text) {
      var p = document.createElement("p");
      p.className = "webmentions__text p-content";
      p.textContent = text;
      body.appendChild(p);
    }

    var src = m.url || m["wm-source"];
    if (src) {
      var srcLink = document.createElement("a");
      srcLink.className = "webmentions__source u-url";
      srcLink.href = src;
      srcLink.rel = "nofollow noopener";
      srcLink.target = "_blank";
      bilingual(srcLink, "View source", "Ver original");
      body.appendChild(srcLink);
    }

    li.appendChild(body);
    return li;
  }

  // --- fetch ----------------------------------------------------------
  var params = new URLSearchParams({
    "per-page": "100",
    "sort-by": "published",
    "sort-dir": "up"
  });
  targetUrls().forEach(function (u) {
    params.append("target[]", u);
  });

  fetch(API + "?" + params.toString())
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then(function (data) {
      var children = (data && data.children) || [];
      if (!children.length) return;

      var facepile = { "like-of": [], "repost-of": [], "bookmark-of": [] };
      var thread = [];
      var seenId = {};
      children.forEach(function (m) {
        var id = m["wm-id"] || m["wm-source"] + "|" + m["wm-property"];
        if (seenId[id]) return;
        seenId[id] = true;
        if (facepile[m["wm-property"]]) facepile[m["wm-property"]].push(m);
        else thread.push(m);
      });

      var shown = 0;
      if (facepileEl) {
        Object.keys(facepile).forEach(function (prop) {
          if (!facepile[prop].length) return;
          facepileEl.appendChild(renderFacepileGroup(prop, facepile[prop]));
          shown += facepile[prop].length;
        });
        if (facepileEl.children.length) facepileEl.hidden = false;
      }

      thread.forEach(function (m) {
        listEl.appendChild(renderThreadItem(m));
        shown += 1;
      });

      if (shown) section.hidden = false;
    })
    .catch(function () {
      /* leave the section hidden */
    });
})();
