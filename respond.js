/*
 * respond.js — the two small progressive-enhancement niceties for a post
 * page's "Respond" affordance and the bilingual `#hash` deep-jump.
 *
 * The received-Webmentions widget itself no longer needs any client-side
 * JS: `render.mjs` bakes the "Responses from around the web" section (and
 * the timeline `.fc-reactions` count lines) into the static HTML at build
 * time from a committed webmention.io snapshot, using the shared
 * `@hhkaos/webmentions-widget` package. See `hhkaos/webmentions-widget#1`.
 *
 * What's left here is purely site-specific and stays local:
 *   - initHashJump: /about ships both language copies with the same section
 *     id; re-jump to the visible one.
 *   - initRespond:  scroll the <details> into view when opened on a phone,
 *     and swap the Webmention form for a thank-you line on submit.
 * Both the toggle and the form work with JS disabled — this only adds the
 * niceties.
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

  // "Respond" affordance — the <details> toggle and the form both work with
  // no JS; this only adds niceties.
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
})();
