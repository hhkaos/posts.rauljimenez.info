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
 * Loaded on every page. On timeline pages (no #webmentions section, but a
 * list of `.fc` cards) it instead adds a compact `♥ n · ↻ n · ↩ n` count
 * line to each card, batching every visible permalink into one API call and
 * watching for cards spliced in by the infinite scroll.
 *
 * Also progressively enhances the post-page "Respond" area: the <details>
 * toggle scrolls into view when opened on a phone, and on submit the form
 * swaps to a thank-you line. Both the toggle and the form (which posts to a
 * hidden iframe) work with JS disabled — this only adds the niceties.
 *
 * Remote mention content is inserted with textContent only — never as HTML.
 *
 * Candidate shared module: the same job is done by a React component in
 * hhkaos/hhkaos.github.io and an inline copy in hhkaos/littlelink. See the
 * "unify the webmention widget" issue on hhkaos/littlelink.
 */
(function () {
  "use strict";

  // Bilingual pages (/about) carry the same section id on both the
  // `.i18n-en` and `.i18n-es` copy; a native anchor jump lands on the first
  // in the DOM, which may be the hidden-language one. Re-jump to the copy
  // that's actually visible. (HEAD_INIT_SCRIPT has already set [data-lang]
  // pre-paint, so the right one is shown by the time this defer script runs.)
  (function initHashJump() {
    function jump() {
      var h = location.hash.slice(1);
      if (!h) return;
      var sel;
      try {
        sel = '[id="' + (window.CSS && CSS.escape ? CSS.escape(h) : h) + '"]';
      } catch (e) {
        return;
      }
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        if (els[i].getClientRects().length) {
          els[i].scrollIntoView();
          return;
        }
      }
    }
    window.addEventListener("hashchange", jump);
    if (location.hash) setTimeout(jump, 0);
  })();

  // "Respond" affordance — wired before the fetch/URL guard so it still
  // works on browsers too old for the mentions fetch below. The <details>
  // toggle and the form both work with no JS; this only adds niceties.
  (function initRespond() {
    var det = document.querySelector(".respond-toggle");
    if (det) {
      // On a phone the panel can open below the fold — pull it into view.
      det.addEventListener("toggle", function () {
        if (
          det.open &&
          window.matchMedia &&
          window.matchMedia("(max-width: 34rem)").matches
        ) {
          det.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    }

    var form = document.querySelector(".respond__form");
    if (!form) return;
    var block = form.closest(".respond__block") || form.parentNode;
    var thanks = block.querySelector(".respond__thanks");
    // The submit event only fires after constraint validation passes; the
    // form still posts natively to its hidden iframe (works with JS off).
    form.addEventListener("submit", function () {
      setTimeout(function () {
        [].forEach.call(block.children, function (el) {
          if (el !== thanks) el.hidden = true;
        });
        if (thanks) thanks.hidden = false;
      }, 0);
    });
  })();

  if (!window.fetch || !window.URL) return;

  var section = document.getElementById("webmentions");
  var facepileEl = document.getElementById("webmentions-facepile");
  var listEl = document.getElementById("webmentions-list");

  var API =
    (section && section.getAttribute("data-wm-api")) ||
    "https://webmention.io/api/mentions.jf2";
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

  // webmention.io / Bridgy mangle emojis into runs of "?" (and sometimes the
  // U+FFFD replacement char) when they extract plain text from a toot/skeet.
  // We can't recover the emoji, so drop the debris cleanly rather than show it.
  function stripMojibake(s) {
    return String(s || "")
      .replace(/�+/g, "")
      .replace(/\s*\?{3,}\s*/g, " ")
      .replace(/\s+([.,!?;:…])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function mentionText(m) {
    var c = m.content || {};
    return truncate(stripMojibake(c.text || stripTags(c.html)));
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
    "like-of": { cls: "is-like", glyph: "♥", en: ["like", "likes"], es: ["me gusta", "me gusta"] },
    "repost-of": { cls: "is-repost", glyph: "↻", en: ["repost", "reposts"], es: ["compartido", "compartidos"] },
    "bookmark-of": { cls: "is-bookmark", glyph: "⚑", en: ["bookmark", "bookmarks"], es: ["guardado", "guardados"] }
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
    var es = document.documentElement.getAttribute("data-lang") === "es";
    var word = n === 1 ? (es ? meta.es[0] : meta.en[0]) : (es ? meta.es[1] : meta.en[1]);
    group.setAttribute("aria-label", n + " " + word);
    group.title = n + " " + word;

    var count = document.createElement("span");
    count.className = "webmentions__count";
    var glyph = document.createElement("span");
    glyph.className = "webmentions__glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = meta.glyph;
    var num = document.createElement("span");
    num.textContent = String(n);
    count.appendChild(glyph);
    count.appendChild(num);
    group.appendChild(count);
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

  // --- detail page: the full "Responses from around the web" section ----
  function initDetail() {
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
  }

  // --- timeline page: a compact count line per card ---------------------
  // Types collapsed into the count line, in display order. Replies and
  // mentions share the ↩ glyph; bookmarks are folded in with ⚑.
  var COUNT_ORDER = [
    { key: "like", cls: "is-like", glyph: "♥", props: ["like-of"] },
    { key: "repost", cls: "is-repost", glyph: "↻", props: ["repost-of"] },
    { key: "reply", cls: "is-reply", glyph: "↩", props: ["in-reply-to", "mention-of"] },
    { key: "bookmark", cls: "is-bookmark", glyph: "⚑", props: ["bookmark-of"] }
  ];
  var PROP_TO_KEY = {};
  COUNT_ORDER.forEach(function (t) {
    t.props.forEach(function (p) { PROP_TO_KEY[p] = t.key; });
  });

  function cardTarget(card) {
    if (card.dataset && card.dataset.canonical) return card.dataset.canonical;
    var a = card.querySelector("a.fc-perma[href], a[href]");
    return a ? a.href : "";
  }

  function normalizeTarget(u) {
    return String(u || "").replace(/\/$/, "").replace(/#.*$/, "");
  }

  function renderCountLine(card, counts) {
    var total = 0;
    COUNT_ORDER.forEach(function (t) { total += counts[t.key] || 0; });
    if (!total) return;

    var line = document.createElement("p");
    line.className = "fc-reactions";
    COUNT_ORDER.forEach(function (t) {
      var n = counts[t.key];
      if (!n) return;
      var span = document.createElement("span");
      span.className = "fc-reactions__c " + t.cls;
      var g = document.createElement("span");
      g.className = "fc-reactions__g";
      g.setAttribute("aria-hidden", "true");
      g.textContent = t.glyph;
      span.appendChild(g);
      span.appendChild(document.createTextNode(" " + n));
      line.appendChild(span);
    });
    card.appendChild(line);
  }

  function fetchCounts(cards) {
    var byTarget = {};
    cards.forEach(function (card) {
      var t = normalizeTarget(cardTarget(card));
      if (!t) return;
      card.dataset.wmCounted = "1";
      (byTarget[t] = byTarget[t] || []).push(card);
    });
    var targets = Object.keys(byTarget);
    if (!targets.length) return;

    var params = new URLSearchParams({ "per-page": "600" });
    targets.forEach(function (t) {
      params.append("target[]", t);
      params.append("target[]", t + "/");
    });

    fetch(API + "?" + params.toString())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var children = data.children || [];
        var counts = {};
        var seen = {};
        children.forEach(function (m) {
          var id = m["wm-id"] || m["wm-source"] + "|" + m["wm-property"];
          if (seen[id]) return;
          seen[id] = true;
          var key = PROP_TO_KEY[m["wm-property"]];
          if (!key) return;
          var t = normalizeTarget(m["wm-target"]);
          (counts[t] = counts[t] || {})[key] = (counts[t][key] || 0) + 1;
        });
        targets.forEach(function (t) {
          if (!counts[t]) return;
          byTarget[t].forEach(function (card) { renderCountLine(card, counts[t]); });
        });
      })
      .catch(function () { /* no counts, no problem */ });
  }

  function initTimeline(root) {
    var cards = [].slice.call(
      (root || document).querySelectorAll(".fc:not([data-wm-counted])")
    );
    if (cards.length) fetchCounts(cards);
  }

  // --- go --------------------------------------------------------------
  if (section && listEl) {
    initDetail();
  } else if (document.querySelector(".fc")) {
    initTimeline(document);
    var feed = document.querySelector(".timeline") || document.body;
    if (window.MutationObserver) {
      new MutationObserver(function (mutations) {
        mutations.forEach(function (mut) {
          [].forEach.call(mut.addedNodes, function (node) {
            if (node.nodeType !== 1) return;
            if (node.matches && node.matches(".fc")) initTimeline(node.parentNode);
            else if (node.querySelector && node.querySelector(".fc")) initTimeline(node);
          });
        });
      }).observe(feed, { childList: true, subtree: true });
    }
  }
})();
