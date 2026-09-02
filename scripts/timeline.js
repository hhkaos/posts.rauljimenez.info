// Progressive enhancement for the timeline: when the bottom of the page comes
// into view, fetch the next numbered page (/page/2/, …) and append its cards,
// so the reader gets infinite scroll. Without this script the numbered pages
// and their "Older →" links work on their own.
(function () {
  "use strict";

  var sentinel = document.getElementById("timeline-end");
  if (!sentinel || !sentinel.dataset.next) return;

  var timeline = document.querySelector(".timeline");
  if (!timeline || typeof IntersectionObserver === "undefined") return;

  var loading = false;

  function lastDayHeading() {
    var headings = timeline.querySelectorAll("h2.feed-day");
    return headings.length ? headings[headings.length - 1] : null;
  }

  function lastFeedList() {
    var lists = timeline.querySelectorAll("ul.feed");
    return lists.length ? lists[lists.length - 1] : null;
  }

  function append(doc) {
    var incoming = doc.querySelector(".timeline");
    if (!incoming) return;

    var nodes = Array.prototype.slice.call(incoming.children);
    var lastHeading = lastDayHeading();
    var mergeInto = null;

    // If the first incoming block repeats the day we already end on, drop its
    // heading and fold its cards into the existing list for that day.
    if (
      nodes.length &&
      nodes[0].tagName === "H2" &&
      lastHeading &&
      nodes[0].textContent.trim() === lastHeading.textContent.trim()
    ) {
      nodes.shift();
      mergeInto = lastFeedList();
      if (nodes.length && nodes[0].tagName === "UL" && mergeInto) {
        Array.prototype.slice.call(nodes.shift().children).forEach(function (li) {
          mergeInto.appendChild(li);
        });
      }
    }

    nodes.forEach(function (node) {
      timeline.appendChild(node);
    });
  }

  function loadNext() {
    if (loading) return;
    var next = sentinel.dataset.next;
    if (!next) {
      observer.disconnect();
      return;
    }
    loading = true;

    fetch(next)
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then(function (text) {
        var doc = new DOMParser().parseFromString(text, "text/html");
        append(doc);

        var pagerNext = document.querySelector(".pager a[rel=next]");
        var nextSentinel = doc.getElementById("timeline-end");
        if (nextSentinel && nextSentinel.dataset.next) {
          sentinel.dataset.next = nextSentinel.dataset.next;
          if (pagerNext) pagerNext.setAttribute("href", nextSentinel.dataset.next);
        } else {
          delete sentinel.dataset.next;
          if (pagerNext) pagerNext.remove();
          observer.disconnect();
        }
        loading = false;
        // Keep the sentinel just above the pager so it can trigger again.
        var pager = document.querySelector(".pager");
        if (pager) pager.parentNode.insertBefore(sentinel, pager);
      })
      .catch(function () {
        // Leave the visible "Older →" link as the fallback.
        loading = false;
        observer.disconnect();
      });
  }

  var observer = new IntersectionObserver(
    function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) loadNext();
    },
    { rootMargin: "600px 0px" },
  );
  observer.observe(sentinel);
})();
