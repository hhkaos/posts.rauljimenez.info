#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link.
//
// The timeline is split into numbered pages (`/`, `/page/2/`, …) that work
// on their own; `scripts/timeline.js` is one small progressive-enhancement
// script that turns them into infinite scroll when JS is available. An Atom
// feed is written to `/feed.xml`, and `/about/` explains what this is.
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import MarkdownIt from "markdown-it";
import YAML from "yaml";

// Post bodies are authored as Markdown (that's what Indiekit's postTemplate
// writes). `linkify` turns bare URLs into links; `breaks` keeps single
// newlines as <br>, matching how short notes are written. `html: false`
// means any literal HTML in a body is escaped, not passed through.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function renderMarkdown(text) {
  return md.render(String(text || "").replace(/\r\n/g, "\n")).trim();
}

// Markdown reduced to a single line of plain text, for list titles etc.
// Tags are stripped and the handful of entities markdown-it emits are
// decoded, so the result is real text safe to re-escape by the caller.
function decodeBasicEntities(string) {
  return string.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'",
  }[e]));
}
function markdownToPlain(text) {
  return decodeBasicEntities(
    md
      .renderInline(String(text || "").replace(/\r\n/g, "\n").replace(/\n+/g, " "))
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

const TYPES = [
  "note", "article", "photo", "bookmark", "like", "reply", "rsvp", "repost",
  "event", "checkin", "review", "read", "watch", "listen",
];
const TYPE_FOLDER = {
  note: "notes", article: "articles", photo: "photos", bookmark: "bookmarks",
  like: "likes", reply: "replies", rsvp: "rsvp", repost: "reposts",
  event: "events", checkin: "checkins", review: "reviews", read: "reads",
  watch: "watches", listen: "listens",
};
const TYPE_LABEL = {
  note: "Note", article: "Article", photo: "Photo", bookmark: "Bookmark",
  like: "Like", reply: "Reply", rsvp: "RSVP", repost: "Repost",
  event: "Event", checkin: "Check-in", review: "Review", read: "Read",
  watch: "Watch", listen: "Listen",
};
const TYPE_VERB = {
  bookmark: "Bookmark of", like: "Like of", reply: "Reply to",
  rsvp: "RSVP to", repost: "Repost of",
};

// checkin / item / read-of / watch-of / listen-of are stored in the front
// matter as a nested map ({ type, name, url, author, latitude, … }); a
// bare string is tolerated as a name-only fallback.
function cite(value) {
  if (!value) return {};
  if (typeof value === "string") return { name: value };
  return value.properties || value;
}
function citeUrl(value) {
  const url = cite(value).url;
  const first = Array.isArray(url) ? url[0] : url;
  return typeof first === "string" && /^https?:\/\//.test(first) ? first : "";
}
const SITE_DIR = "_site";
const BASE_URL = "https://posts.rauljimenez.info";
const MAIN_SITE = "https://www.rauljimenez.info/";
const ABOUT_POST = "https://www.rauljimenez.info/blog/first-steps-into-the-indieweb";
const SOURCE_REPO = "https://github.com/hhkaos/posts.rauljimenez.info";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

// Timeline pagination. Overridable via env so pagination can be exercised
// locally without hundreds of posts.
const PAGE_SIZE = Number(process.env.TIMELINE_PAGE_SIZE) || 20;
// Atom feed: newest N entries only.
const FEED_MAX = 50;

// Navbar — a faithful mirror of the Docusaurus navbar on www.rauljimenez.info
// so the two sites read as one. The logo is hotlinked from the main site
// (same owner); vendor it into this repo if that dependency is unwanted.
const LOGO_URL = "https://www.rauljimenez.info/img/rauljimenez.info.png";
const NAV_LINKS = [
  { label: "🧠 Digital Brain", href: "https://www.rauljimenez.info/docs/digital-brain" },
  { label: "📝 Blog", href: "https://www.rauljimenez.info/blog" },
  { label: "📡 Activity", href: `${BASE_URL}/`, current: true },
  { label: "🤓 About me", href: "https://www.rauljimenez.info/docs/category/-about-me" },
];

// Author identity. Webmention receivers (e.g. webmention.io) extract the
// author of a mention from microformats2: a representative h-card on the
// source page and/or a nested h-card in the h-entry's `author` property.
// Both need name + url + photo, and the photo URL must be absolute.
const AUTHOR_NAME = "Raúl Jiménez Ortega";
const AUTHOR_URL = MAIN_SITE; // https://www.rauljimenez.info/
const AUTHOR_PHOTO = "https://www.rauljimenez.info/img/hhkaos-raul-jimenez-ortega.jpeg";

// Hidden representative h-card — dropped on every *post* page (not the
// index, see `page()`). Its `u-url` is also a `rel="me"` link, which makes
// it the representative h-card per the IndieWeb rep-hcard algorithm.
function repHCard() {
  return `<div class="h-card" hidden>
<a class="p-name u-url" href="${AUTHOR_URL}" rel="me">${escapeHtml(AUTHOR_NAME)}</a>
<img class="u-photo" src="${AUTHOR_PHOTO}" alt="">
</div>`;
}

// Inline author for an h-entry / h-event / h-review. Parses as a nested
// h-card with explicit `u-url`, `u-photo` and `p-name` children (implied
// `url` is not derived once the h-card has a `u-photo` child, so it must
// be explicit). Compact avatar styling lives in style.css (.p-author.h-card).
function authorHCard() {
  return `<span class="p-author h-card"><a class="u-url" href="${AUTHOR_URL}" rel="author"><img class="u-photo" src="${AUTHOR_PHOTO}" alt=""><span class="p-name">${escapeHtml(AUTHOR_NAME)}</span></a></span>`;
}

// Mirrors the default applied in indiekit.config.js's postTemplate:
// everything created through the Indiekit server is an explicit act of
// publishing, so anything without a `visibility` property is public.
function resolveVisibility(_type, properties) {
  return properties.visibility || "public";
}

function escapeHtml(string) {
  return String(string).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function parsePost(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const properties = YAML.parse(match[1]) || {};
  const content = match[2].trim();
  return { properties, content };
}

function slugAndDateFromFilename(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/);
  if (!match) return null;
  const [, yyyy, MM, dd, slug] = match;
  return { yyyy, MM, dd, slug };
}

function targetOf(properties) {
  return (
    properties["bookmark-of"] || properties["like-of"] || properties["in-reply-to"] ||
    properties["repost-of"] || null
  );
}

function targetClassOf(type) {
  return {
    bookmark: "u-bookmark-of", like: "u-like-of", reply: "u-in-reply-to",
    rsvp: "u-in-reply-to", repost: "u-repost-of",
  }[type];
}

// Micropub `location` can be a plain string or an h-adr/h-geo object.
function locationText(location) {
  if (!location) return "";
  if (typeof location === "string") return location;
  const p = location.properties || location;
  return p.name || p.label || p["street-address"] || p.locality || "";
}

// Times are shown in the author's timezone (posts carry a UTC `published`).
const TZ = "Europe/Madrid";

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// "2 Sep 2026, 21:57" — used on post pages and (date part) as the feed
// day heading; the feed cards themselves show just the time.
function formatDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-GB", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    return `${date}, ${time}`;
  } catch {
    return iso;
  }
}

function feedTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function feedDay(iso) {
  if (!iso) return "Undated";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "Undated";
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Body reduced to a plain-text snippet for feed cards (images/links stripped).
function excerptOf(text, max = 190) {
  const plain = markdownToPlain(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

// First inline Markdown image in a body — lets reviews / reads / notes show
// their illustration in the feed (photo posts use `properties.photo`).
function firstContentImage(text) {
  const m = String(text || "").match(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/);
  return m ? { url: m[2], alt: m[1] || "" } : null;
}

// "20–23 Oct 2026" when start/end share a month, else "20 Oct – 23 Oct 2026".
function formatDateRange(start, end) {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  try {
    const s = new Date(start);
    const eD = new Date(end);
    const sameMonth = s.getUTCFullYear() === eD.getUTCFullYear() && s.getUTCMonth() === eD.getUTCMonth();
    if (sameMonth) {
      return `${s.getUTCDate()}–${formatDate(end)}`;
    }
    return `${formatDate(start)} – ${formatDate(end)}`;
  } catch {
    return formatDate(start);
  }
}

function stars(rating) {
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < 1) return "";
  const n = Math.min(r, 5);
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// A DMS coordinate string ("37° 55′ 15.52″ N …") is not a place name worth
// showing — geo check-ins/photos store one as `location.name`.
function isCoordinateName(name) {
  return /\d\s*°/.test(String(name || ""));
}

// Fixed navbar shared with www.rauljimenez.info. Rendered outside `.wrap`.
function siteNav() {
  const links = NAV_LINKS.map((l) =>
    `<a class="site-nav__link"${l.current ? ' aria-current="page"' : ""} href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`,
  ).join("\n");
  return `<nav class="site-nav">
<a class="site-nav__brand" href="${MAIN_SITE}"><img src="${LOGO_URL}" alt="Raúl Jiménez Ortega"></a>
<div class="site-nav__links">
${links}
</div>
</nav>`;
}

// `og` (optional): { url, description, image, type } for a post page.
// `image` is a screenshot generated by scripts/screenshot.mjs; the same
// file is attached as native media when the post is syndicated.
// `repCard` (default true): emit the hidden representative h-card. The
// index page passes false — it has no h-entry, so a top-level h-card there
// makes XRay (what webmention.io uses to verify) treat the whole page as a
// person card and stop looking for the target link in the page body, which
// breaks Webmentions *sent from* the index. Post pages have an h-entry that
// outranks the h-card, so it's safe (and useful) there.
function page({ title, body, og, repCard = true }) {
  const socialMeta = og
    ? `
<link rel="canonical" href="${escapeHtml(og.url)}">
<meta property="og:site_name" content="Raul Jimenez — activity">
<meta property="og:type" content="${escapeHtml(og.type || "article")}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:url" content="${escapeHtml(og.url)}">
${og.description ? `<meta property="og:description" content="${escapeHtml(og.description)}">` : ""}
${og.image ? `<meta property="og:image" content="${escapeHtml(og.image)}">` : ""}
<meta name="twitter:card" content="${og.image ? "summary_large_image" : "summary"}">`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>${socialMeta}
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/atom+xml" title="Raúl Jiménez — Activity" href="/feed.xml">
</head>
<body>
${siteNav()}
<div class="wrap">
${repCard ? repHCard() : ""}
${body}
<footer class="site">
<a href="${MAIN_SITE}">www.rauljimenez.info</a>
<a href="${BASE_URL}/about/">About this feed</a>
<a href="/feed.xml">RSS</a>
<a href="${SOURCE_REPO}">Source on GitHub</a>
</footer>
</div>
<script src="/timeline.js" defer></script>
</body>
</html>
`;
}

function renderMetaRow(type, published) {
  return `<div class="meta">
<span class="badge ${type}">${escapeHtml(TYPE_LABEL[type])}</span>
${published ? `<time class="dt-published" datetime="${escapeHtml(published)}">${escapeHtml(formatDateTime(published))}</time>` : ""}
</div>`;
}

function renderPermalink(url, properties) {
  return `<p style="margin-top:1.5rem"><a class="u-url" href="${escapeHtml(url)}">Permalink</a> · ${authorHCard()}</p>${syndicationLinks(properties)}`;
}

// IndieWeb POSSE: link the canonical post to its syndicated copies with
// `u-syndication` (also lets Bridgy-style backfeed match them). `syndication`
// in the front matter is an array of status URLs written back by
// @indiekit/endpoint-syndicate.
const SYNDICATION_LABEL = {
  "mastodon.social": "Mastodon",
  "bsky.app": "Bluesky",
};
function syndicationLabel(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    return SYNDICATION_LABEL[host] || host;
  } catch {
    return href;
  }
}
function syndicationLinks(properties) {
  const urls = [].concat(properties?.syndication || []).filter((u) => typeof u === "string" && u);
  if (!urls.length) return "";
  const links = urls
    .map((u) => `<a class="u-syndication" href="${escapeHtml(u)}">${escapeHtml(syndicationLabel(u))}</a>`)
    .join(", ");
  return `\n<p class="syndication">Also posted on ${links}</p>`;
}

function ogDescription(text, fallback) {
  const plain = markdownToPlain(text);
  if (!plain) return fallback;
  return plain.length > 200 ? `${plain.slice(0, 199).trimEnd()}…` : plain;
}

// screenshot.mjs writes screenshot.png alongside each post's index.html.
function screenshotUrl(url) {
  return `${url}/screenshot.png`;
}

// h-event: name/start/end/location live in the front matter, not the body.
function renderEventHtml({ url, properties, content }) {
  const published = properties.published || "";
  const name = properties.name || "Event";
  const start = properties.start || "";
  const end = properties.end || "";
  const location = locationText(properties.location);
  const eventUrl = properties.url;

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-event">
${renderMetaRow("event", published)}
<h1 class="p-name">${escapeHtml(name)}</h1>
<p class="event-when">
${start ? `<time class="dt-start" datetime="${escapeHtml(start)}">${escapeHtml(formatDate(start))}</time>` : ""}
${end ? ` – <time class="dt-end" datetime="${escapeHtml(end)}">${escapeHtml(formatDate(end))}</time>` : ""}
</p>
${location ? `<p class="event-where">📍 <span class="p-location">${escapeHtml(location)}</span></p>` : ""}
${eventUrl ? `<p class="target"><a class="u-url" href="${escapeHtml(eventUrl)}">${escapeHtml(eventUrl)}</a></p>` : ""}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
<p style="margin-top:1.5rem">${
  eventUrl
    ? `<a href="${escapeHtml(url)}">Permalink</a>`
    : `<a class="u-url" href="${escapeHtml(url)}">Permalink</a>`
} · ${authorHCard()}</p>${syndicationLinks(properties)}
</article>`;

  const when = [formatDate(start), end && `– ${formatDate(end)}`].filter(Boolean).join(" ");
  return page({
    title: name,
    body,
    og: {
      url,
      type: "event",
      image: screenshotUrl(url),
      description: ogDescription(content, [when, location].filter(Boolean).join(" · ")),
    },
  });
}

// Photos: `properties.photo` is an array of { url, alt } (or bare URL
// strings). Body text, if any, is the caption.
function photoList(photo) {
  return [].concat(photo || []).map((p) =>
    typeof p === "string"
      ? { url: p }
      : (p.properties
        ? { url: p.properties.url?.[0] ?? p.properties.url, alt: p.properties.alt?.[0] ?? p.properties.alt }
        : p),
  ).filter((p) => p && p.url);
}
function photoImgs(photos) {
  return photos.map((p) => `<img class="u-photo" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.alt || "")}" loading="lazy">`).join("\n");
}

function renderPhotoHtml({ url, properties, content }) {
  const published = properties.published || "";
  const photos = photoList(properties.photo);

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow("photo", published)}
${properties.name ? `<h1 class="p-name">${escapeHtml(properties.name)}</h1>` : ""}
${photoImgs(photos)}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties)}
</article>`;

  return page({
    title: properties.name || `Photo — ${formatDate(published)}`,
    body,
    og: { url, type: "article", image: photos[0]?.url || screenshotUrl(url), description: ogDescription(content, "Photo · posts.rauljimenez.info") },
  });
}

// Articles: title in the front matter, long-form body.
function renderArticleHtml({ url, properties, content }) {
  const published = properties.published || "";
  const name = properties.name || "Article";
  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow("article", published)}
<h1 class="p-name">${escapeHtml(name)}</h1>
<div class="content e-content">${renderMarkdown(content)}</div>
${renderPermalink(url, properties)}
</article>`;
  return page({
    title: name,
    body,
    og: { url, type: "article", image: screenshotUrl(url), description: ogDescription(properties.summary || content, name) },
  });
}

// h-entry with a nested h-card for the venue (`checkin`). No Webmention is
// sent for these (a check-in isn't a response to another page).
function renderCheckinHtml({ url, properties, content }) {
  const published = properties.published || "";
  const c = cite(properties.checkin);
  const name = c.name || "a place";
  const venueUrl = citeUrl(properties.checkin);
  const lat = c.latitude;
  const lon = c.longitude;
  const mapHref = venueUrl
    || (lat && lon ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=17/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}` : "");

  const venue = `<span class="p-location h-card">${
    mapHref
      ? `<a class="p-name u-url" href="${escapeHtml(mapHref)}">${escapeHtml(name)}</a>`
      : `<span class="p-name">${escapeHtml(name)}</span>`
  }${lat && lon ? `<data class="p-latitude" value="${escapeHtml(lat)}"></data><data class="p-longitude" value="${escapeHtml(lon)}"></data>` : ""}</span>`;

  const photos = photoList(properties.photo);
  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow("checkin", published)}
<p class="target">📍 Checked in at ${venue}</p>
${photoImgs(photos)}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties)}
</article>`;

  return page({
    title: `Check-in at ${name}`,
    body,
    og: { url, type: "article", image: screenshotUrl(url), description: ogDescription(content, `Checked in at ${name}`) },
  });
}

// h-review: the reviewed thing is `item` (rendered as p-item h-item), the
// score is `rating` on a 1–5 scale, the body is the p-description.
function renderReviewHtml({ url, properties, content }) {
  const published = properties.published || "";
  const it = cite(properties.item);
  const itemName = it.name || "something";
  const itemUrl = citeUrl(properties.item);
  const rating = Number(properties.rating);
  const hasRating = Number.isFinite(rating);
  const headline = properties.name || "";

  const item = `<span class="p-item h-item">${
    itemUrl
      ? `<a class="p-name u-url" href="${escapeHtml(itemUrl)}">${escapeHtml(itemName)}</a>`
      : `<span class="p-name">${escapeHtml(itemName)}</span>`
  }${it.author ? ` by <span class="p-author">${escapeHtml(it.author)}</span>` : ""}</span>`;

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-review">
${renderMetaRow("review", published)}
<p class="target">📝 Review of ${item}</p>
${headline ? `<h1 class="p-name">${escapeHtml(headline)}</h1>` : ""}
${hasRating ? `<p class="review-rating">Rating: <data class="p-rating" value="${rating}">${rating}</data><data class="p-best" value="5"></data><data class="p-worst" value="1"></data> / 5</p>` : ""}
<div class="content e-content p-description">${renderMarkdown(content)}</div>
${renderPermalink(url, properties)}
</article>`;

  return page({
    title: headline || `Review of ${itemName}`,
    body,
    og: { url, type: "article", image: screenshotUrl(url), description: ogDescription(content, `Review of ${itemName}${hasRating ? ` — ${rating}/5` : ""}`) },
  });
}

// read / watch / listen — an h-entry citing the consumed work (h-cite).
const CONSUMED = {
  read: { prop: "read-of", uClass: "u-read-of", icon: "📚", verb: "Read", statusProp: "read-status" },
  watch: { prop: "watch-of", uClass: "u-watch-of", icon: "🎬", verb: "Watched" },
  listen: { prop: "listen-of", uClass: "u-listen-of", icon: "🎧", verb: "Listened to" },
};
const READ_STATUS_LABEL = {
  "to-read": "Want to read", "want-to-read": "Want to read",
  reading: "Reading", finished: "Finished reading", read: "Finished reading",
};
function renderConsumedHtml(type, { url, properties, content }) {
  const spec = CONSUMED[type];
  const published = properties.published || "";
  const w = cite(properties[spec.prop]);
  const workName = w.name || "something";
  const workUrl = citeUrl(properties[spec.prop]);
  const rating = Number(properties.rating);
  const hasRating = Number.isFinite(rating);
  const status = spec.statusProp ? String(properties[spec.statusProp] || "").toLowerCase() : "";
  const verb = status ? (READ_STATUS_LABEL[status] || spec.verb) : spec.verb;

  const work = `<span class="${spec.uClass} h-cite">${
    workUrl
      ? `<a class="p-name u-url" href="${escapeHtml(workUrl)}">${escapeHtml(workName)}</a>`
      : `<span class="p-name">${escapeHtml(workName)}</span>`
  }${w.author ? ` by <span class="p-author">${escapeHtml(w.author)}</span>` : ""}</span>`;

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow(type, published)}
${status ? `<data class="p-read-status" value="${escapeHtml(status)}"></data>` : ""}
<p class="target">${spec.icon} ${escapeHtml(verb)} ${work}${hasRating ? ` — <data class="p-rating" value="${rating}">${rating}/5</data>` : ""}</p>
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties)}
</article>`;

  return page({
    title: `${verb} ${workName}`,
    body,
    og: { url, type: "article", image: screenshotUrl(url), description: ogDescription(content, `${verb} ${workName}`) },
  });
}

function renderPostHtml({ type, url, properties, content }) {
  // A check-in that also carries a photo is stored as `post-type: photo`
  // (Indiekit's discovery can't be reordered) — treat any post with a
  // `checkin` property as a check-in.
  if (properties.checkin) return renderCheckinHtml({ url, properties, content });
  if (type === "event") return renderEventHtml({ url, properties, content });
  if (type === "review") return renderReviewHtml({ url, properties, content });
  if (type === "read" || type === "watch" || type === "listen") {
    return renderConsumedHtml(type, { url, properties, content });
  }
  if (type === "article") return renderArticleHtml({ url, properties, content });
  if (type === "photo") return renderPhotoHtml({ url, properties, content });

  const target = targetOf(properties);
  const published = properties.published || "";
  const rsvp = type === "rsvp" ? properties.rsvp : "";

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow(type, published)}
${rsvp ? `<p class="rsvp-answer">RSVP: <data class="p-rsvp" value="${escapeHtml(rsvp)}">${escapeHtml(rsvp)}</data></p>` : ""}
${target ? `<p class="target">${escapeHtml(TYPE_VERB[type] || "")} <a class="${targetClassOf(type)}" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>` : ""}
<div class="content e-content">${renderMarkdown(content)}</div>
${renderPermalink(url, properties)}
</article>`;

  const fallbackDescription =
    (TYPE_VERB[type] && target ? `${TYPE_VERB[type]} ${target}` : `${TYPE_LABEL[type]} · posts.rauljimenez.info`);
  return page({
    title: properties.name || `${TYPE_LABEL[type]} — ${formatDate(published)}`,
    body,
    og: {
      url,
      type: "article",
      image: screenshotUrl(url),
      description: ogDescription(content, fallbackDescription),
    },
  });
}

// Everything the timeline needs to render one card so the post reads at a
// glance: an icon + action verb, the thing it refers to (linked), a rating,
// a body excerpt and any image. `action` is left empty for types whose
// badge already says it all (note/photo/article/event).
const RSVP_ACTION = {
  yes: ["✅", "Going to"], no: ["❌", "Not going to"],
  maybe: ["❔", "Maybe going to"], interested: ["⭐", "Interested in"],
};
function feedEntry(type, properties, content, _url) {
  const e = {
    type, badge: TYPE_LABEL[type], icon: "", action: "", subject: "",
    subjectUrl: "", author: "", rating: null, headline: "", excerpt: "",
    images: [], contextHost: "", whenLine: "",
  };
  const body = excerptOf(content);

  const linkTarget = (t) => {
    const host = hostOf(t);
    e.subject = properties.name || host || (typeof t === "string" ? t : "");
    e.subjectUrl = typeof t === "string" ? t : "";
    // Only worth a separate context line when we have a real title above it.
    if (properties.name && host) e.contextHost = host;
    e.excerpt = body;
  };
  const consumed = () => {
    const spec = CONSUMED[type];
    const w = cite(properties[spec.prop]);
    const status = spec.statusProp ? String(properties[spec.statusProp] || "").toLowerCase() : "";
    e.icon = spec.icon;
    e.action = status ? (READ_STATUS_LABEL[status] || spec.verb) : spec.verb;
    e.subject = w.name || "something";
    e.subjectUrl = citeUrl(properties[spec.prop]) || "";
    e.author = w.author || "";
    e.contextHost = hostOf(e.subjectUrl);
    const r = Number(properties.rating);
    e.rating = Number.isFinite(r) ? r : null;
    e.excerpt = body;
    const img = firstContentImage(content);
    if (img) e.images = [img];
  };

  switch (type) {
    case "bookmark":
      e.icon = "🔖"; e.action = "Bookmarked"; linkTarget(properties["bookmark-of"]);
      break;
    case "like":
      e.icon = "⭐"; e.action = "Liked"; linkTarget(properties["like-of"]);
      break;
    case "reply":
      e.icon = "💬"; e.action = "Replied to"; linkTarget(properties["in-reply-to"]);
      break;
    case "repost":
      e.icon = "🔁"; e.action = "Reposted"; linkTarget(properties["repost-of"]);
      break;
    case "rsvp": {
      const [icon, verb] = RSVP_ACTION[String(properties.rsvp || "").toLowerCase()] || ["🗓️", "RSVP to"];
      e.icon = icon; e.action = verb; linkTarget(properties["in-reply-to"]);
      break;
    }
    case "event": {
      const speaking = [].concat(properties.category || []).includes("speaking");
      e.headline = `${speaking ? "🎤 " : ""}${properties.name || "Event"}`;
      const locName = locationText(properties.location);
      const locCity = properties.location?.locality || properties.location?.properties?.locality;
      const loc = [locName, locCity && locName !== locCity ? locCity : ""].filter(Boolean).join(", ");
      e.whenLine = [formatDateRange(properties.start, properties.end), loc].filter(Boolean).join(" · ");
      e.excerpt = body;
      break;
    }
    case "checkin": {
      const c = cite(properties.checkin);
      e.icon = "📍"; e.action = "Checked in at";
      e.subject = c.name || "a place";
      e.subjectUrl = citeUrl(properties.checkin) || "";
      e.images = photoList(properties.photo);
      e.excerpt = body;
      break;
    }
    case "review": {
      const it = cite(properties.item);
      e.icon = "📝"; e.action = "Reviewed";
      e.subject = it.name || "something";
      e.subjectUrl = citeUrl(properties.item) || "";
      e.author = it.author || "";
      e.contextHost = hostOf(e.subjectUrl);
      const r = Number(properties.rating);
      e.rating = Number.isFinite(r) ? r : null;
      e.headline = properties.name || "";
      e.excerpt = body;
      const img = firstContentImage(content);
      if (img) e.images = [img];
      break;
    }
    case "read":
    case "watch":
    case "listen":
      consumed();
      break;
    case "photo": {
      e.headline = properties.name || "";
      e.images = photoList(properties.photo);
      const place = locationText(properties.location);
      if (place && !isCoordinateName(place)) e.whenLine = `📍 ${place}`;
      e.excerpt = body;
      break;
    }
    case "article":
      e.headline = properties.name || "Article";
      e.excerpt = excerptOf(properties.summary || content);
      { const img = firstContentImage(content); if (img) e.images = [img]; }
      break;
    default: // note
      e.headline = properties.name || "";
      e.excerpt = body;
      { const img = firstContentImage(content); if (img) e.images = [img]; }
  }
  return e;
}

function feedImages(images, max = 4) {
  const list = images.slice(0, max);
  if (!list.length) return "";
  const imgs = list
    .map((p) => `<img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.alt || "")}" loading="lazy">`)
    .join("");
  return `<div class="fc-media${list.length > 1 ? " fc-media--multi" : ""}">${imgs}</div>`;
}

function renderFeedCard(e, url, published) {
  const subject = e.subject
    ? (e.subjectUrl
      ? `<a class="fc-subject" href="${escapeHtml(e.subjectUrl)}">${escapeHtml(e.subject)}</a>`
      : `<span class="fc-subject">${escapeHtml(e.subject)}</span>`)
    : "";
  const action = e.action
    ? `<p class="fc-action"><span class="fc-icon">${e.icon}</span> ${escapeHtml(e.action)}${subject ? ` ${subject}` : ""}${e.author ? ` <span class="fc-by">by ${escapeHtml(e.author)}</span>` : ""}${e.rating ? ` <span class="fc-rating" title="${e.rating}/5">${stars(e.rating)}</span>` : ""}</p>`
    : "";
  const headline = e.headline ? `<p class="fc-headline">${escapeHtml(e.headline)}</p>` : "";
  const when = e.whenLine ? `<p class="fc-when">${escapeHtml(e.whenLine)}</p>` : "";
  const excerpt = e.excerpt ? `<p class="fc-excerpt">${escapeHtml(e.excerpt)}</p>` : "";
  const context = e.contextHost ? `<p class="fc-context">${escapeHtml(e.contextHost)}</p>` : "";

  return `<li class="fc fc--${e.type}">
<a class="fc-perma" href="${escapeHtml(url)}" aria-label="Open this post"></a>
<div class="fc-head">
<span class="badge ${e.type}">${escapeHtml(e.badge)}</span>
<time datetime="${escapeHtml(published || "")}">${escapeHtml(feedTime(published))}</time>
</div>
${action}${headline}${when}${excerpt}${feedImages(e.images)}${context}
</li>`;
}

// Reverse-chronological cards for one page of the timeline, grouped under a
// per-calendar-day heading. `timeline.js` relies on this exact shape (a
// `.timeline` wrapper, `h2.feed-day` headings, sibling `ul.feed` lists) to
// splice pages together, deduping a heading repeated at a page seam.
function renderTimeline(items) {
  let html = "";
  let currentDay = null;
  for (const p of items) {
    const day = feedDay(p.published);
    if (day !== currentDay) {
      if (currentDay !== null) html += "</ul>\n";
      html += `<h2 class="feed-day">${escapeHtml(day)}</h2>\n<ul class="feed">\n`;
      currentDay = day;
    }
    html += `${renderFeedCard(p.entry, p.url, p.published)}\n`;
  }
  if (currentDay !== null) html += "</ul>";
  return `<div class="timeline">\n${html}\n</div>`;
}

// Bottom-of-page pager + the sentinel `timeline.js` observes. `next` is the
// path of the older page (or "" on the last page).
function pager(prev, next) {
  const links = [
    prev ? `<a class="pager__link" rel="prev" href="${escapeHtml(prev)}">← Newer</a>` : "<span></span>",
    next ? `<a class="pager__link" rel="next" href="${escapeHtml(next)}">Older →</a>` : "<span></span>",
  ].join("\n");
  return `<nav class="pager">\n${links}\n</nav>\n<div id="timeline-end"${next ? ` data-next="${escapeHtml(next)}"` : ""}></div>`;
}

function xmlEscape(string) {
  return String(string).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[c]);
}

// A short human title for a feed entry, reusing the timeline card model.
function feedEntryTitle(item) {
  const e = item.entry;
  if (e.headline) return e.headline;
  if (e.action) return [e.action, e.subject].filter(Boolean).join(" ");
  return `${TYPE_LABEL[item.type] || "Post"} — ${formatDate(item.published)}`;
}

// Atom 1.0 feed of the newest FEED_MAX posts. Built from the same sorted
// `index` main() already has — no extra passes over the content tree.
function buildFeed(index) {
  const items = index.slice(0, FEED_MAX);
  const updated = items[0]?.published || new Date().toISOString();

  const entries = items.map((item) => {
    const e = item.entry;
    const title = feedEntryTitle(item);
    const subject = e.subject
      ? (e.subjectUrl
        ? `<a href="${escapeHtml(e.subjectUrl)}">${escapeHtml(e.subject)}</a>`
        : escapeHtml(e.subject))
      : "";
    const actionLine = e.action
      ? `<p>${e.icon ? `${escapeHtml(e.icon)} ` : ""}${escapeHtml(e.action)}${subject ? ` ${subject}` : ""}${e.author ? ` by ${escapeHtml(e.author)}` : ""}${e.rating ? ` — ${escapeHtml(stars(e.rating))}` : ""}</p>`
      : "";
    const image = e.images?.[0]
      ? `<p><img src="${escapeHtml(e.images[0].url)}" alt="${escapeHtml(e.images[0].alt || "")}"></p>`
      : "";
    const bodyHtml = item.contentHtml || "";
    const html = `${actionLine}${image}${bodyHtml}`.trim()
      || `<p>${escapeHtml(feedEntryTitle(item))}</p>`;
    return `  <entry>
    <title>${xmlEscape(title)}</title>
    <link href="${xmlEscape(item.url)}"/>
    <id>${xmlEscape(item.url)}</id>
    <published>${xmlEscape(item.published || updated)}</published>
    <updated>${xmlEscape(item.published || updated)}</updated>
    <category term="${xmlEscape(item.type)}"/>
    <content type="html">${xmlEscape(html)}</content>
  </entry>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Raúl Jiménez — Activity</title>
  <subtitle>Notes, links, photos, events, reviews and things read, watched and listened to — self-hosted, not on a platform.</subtitle>
  <link href="${BASE_URL}/feed.xml" rel="self"/>
  <link href="${BASE_URL}/"/>
  <id>${BASE_URL}/</id>
  <updated>${xmlEscape(updated)}</updated>
  <author>
    <name>${xmlEscape(AUTHOR_NAME)}</name>
    <uri>${xmlEscape(AUTHOR_URL)}</uri>
  </author>
${entries}
</feed>
`;
}

function renderAboutHtml() {
  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="content e-content prose">
<h1>About this feed</h1>

<p><strong>This is my activity feed.</strong> It's the kind of thing you'd
normally post on a social network — short notes, links I found worth keeping,
photos, events I'm going to, things I've read, watched or listened to — except
it doesn't live on a platform. It lives on my own domain, and every post is a
plain file in a public Git repository I control:
<a href="${SOURCE_REPO}">github.com/hhkaos/posts.rauljimenez.info</a>.</p>

<p>It's built following the <a href="https://indieweb.org/">IndieWeb</a>
approach: <em>your content, on your site, first</em>. If you're curious why I
bothered, the <a href="https://indieweb.org/why">reasons</a> and
<a href="https://indieweb.org/principles">principles</a> are worth a read, and I
wrote up how I put this together in
<a href="${ABOUT_POST}">First steps into the IndieWeb</a>.</p>

<h2>Not just the usual "post" types</h2>
<p>A social network gives you a status box and maybe a photo upload. Here the
"posts" are typed: notes, bookmarks, likes, replies, reposts, RSVPs, events,
check-ins, reviews, and separate types for things read, watched and listened
to. Some of these have no real equivalent on a mainstream network.</p>

<h2>Where else it shows up</h2>
<p>Not everything here is cross-posted to my social accounts — but a lot of it
is. When it is, this copy is the canonical one and the social post links back
to it (the IndieWeb calls this
<a href="https://indieweb.org/POSSE">POSSE</a>). Either way, the complete and
permanent record is the <a href="${SOURCE_REPO}">GitHub repo</a>.</p>

<h2>Why not just use social media</h2>
<p>Because the social platforms we know are not neutral tools. Their incentives
are not my incentives, they can disappear my content or my account, and the way
they're designed to hold attention has real costs. If that sounds abstract, the
documentary <a href="https://www.imdb.com/title/tt11464826/"><em>The Social
Dilemma</em></a> lays it out well. Owning this myself is a small way of opting
out.</p>

<h2>License</h2>
<p>All <strong>content</strong> published on this site — text, photos — is
licensed <a href="${LICENSE_URL}" rel="license"><strong>Creative Commons
Attribution 4.0 International (CC&nbsp;BY&nbsp;4.0)</strong></a>. You're free to
share and adapt it, including commercially, as long as you credit me
(name + a link back). The site's source code, in the repository above, is a
separate matter.</p>

<p style="margin-top:2rem"><a href="${BASE_URL}/">&larr; Back to the timeline</a>
· <a href="/feed.xml">RSS</a></p>
</article>`;
  return page({
    title: "About this feed — Raul Jimenez activity",
    body,
    repCard: false,
    og: {
      url: `${BASE_URL}/about/`,
      type: "website",
      description: "What this activity feed is, why it's self-hosted and not on a social platform, and how the content is licensed.",
    },
  });
}

async function main() {
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, ".nojekyll"), "");
  await writeFile(path.join(SITE_DIR, "CNAME"), "posts.rauljimenez.info\n");
  await copyFile("scripts/style.css", path.join(SITE_DIR, "style.css"));

  // Media uploaded via Micropub (@indiekit/store-github writes it to `media/`).
  // Posts reference these by absolute URL under posts.rauljimenez.info, so the
  // files must be served from the Pages site verbatim — nothing else copies them.
  try {
    await cp("media", path.join(SITE_DIR, "media"), { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // no media/ folder yet is fine
  }

  const index = [];

  for (const type of TYPES) {
    const folder = TYPE_FOLDER[type];
    let filenames = [];
    try {
      filenames = (await readdir(folder)).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // Folder doesn't exist yet — nothing published of this type
    }

    for (const filename of filenames) {
      const parsedName = slugAndDateFromFilename(filename);
      if (!parsedName) continue;

      const raw = await readFile(path.join(folder, filename), "utf8");
      const post = parsePost(raw);
      if (!post) continue;

      const visibility = resolveVisibility(type, post.properties);
      if (visibility !== "public") continue;

      const { yyyy, MM, dd, slug } = parsedName;
      const url = `${BASE_URL}/${folder}/${yyyy}/${MM}/${dd}/${slug}`;
      const outDir = path.join(SITE_DIR, folder, yyyy, MM, dd, slug);
      await mkdir(outDir, { recursive: true });
      await writeFile(
        path.join(outDir, "index.html"),
        renderPostHtml({ type, url, properties: post.properties, content: post.content }),
      );

      const props = post.properties;
      const effectiveType = props.checkin ? "checkin" : type;
      index.push({
        type: effectiveType,
        url,
        published: props.published,
        entry: feedEntry(effectiveType, props, post.content, url),
        contentHtml: post.content ? renderMarkdown(post.content) : "",
      });
    }
  }

  index.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  await copyFile("scripts/timeline.js", path.join(SITE_DIR, "timeline.js"));
  await writeFile(path.join(SITE_DIR, "feed.xml"), buildFeed(index));

  await mkdir(path.join(SITE_DIR, "about"), { recursive: true });
  await writeFile(path.join(SITE_DIR, "about", "index.html"), renderAboutHtml());

  // Split the timeline into numbered pages. `/` is page 1; `/page/2/`, … hold
  // the rest. Each page stands alone (working prev/next links); timeline.js
  // stitches them into infinite scroll when it can.
  const intro = `<header class="site">
<h1>Activity</h1>
<p class="page-intro">The kind of things I'd normally post on a social network — notes, links, photos, events, things I've read or watched — except this feed runs on <a href="${MAIN_SITE}">my own site</a> instead of a platform I don't control. <a href="${BASE_URL}/about/">About this feed &amp; why &rarr;</a> · <a href="/feed.xml">RSS</a></p>
</header>`;

  const pageCount = Math.max(1, Math.ceil(index.length / PAGE_SIZE));
  for (let n = 1; n <= pageCount; n++) {
    const slice = index.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
    // Root-relative so the links + timeline.js fetch work on any host.
    const prev = n === 1 ? "" : n === 2 ? "/" : `/page/${n - 1}/`;
    const next = n < pageCount ? `/page/${n + 1}/` : "";

    const header = n === 1
      ? intro
      : `<header class="site"><h1>Activity</h1><p class="page-intro">Page ${n} of ${pageCount} · <a href="${BASE_URL}/">newest &rarr;</a></p></header>`;

    const body = index.length
      ? `${header}\n${renderTimeline(slice)}\n${pager(prev, next)}`
      : `${intro}\n<p>Nothing public yet.</p>`;

    const html = page({
      title: n === 1 ? "Raul Jimenez — activity" : `Activity — page ${n}`,
      body,
      repCard: false,
    });

    if (n === 1) {
      await writeFile(path.join(SITE_DIR, "index.html"), html);
    } else {
      const dir = path.join(SITE_DIR, "page", String(n));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.html"), html);
    }
  }

  console.log(`Rendered ${index.length} public post(s) into ${SITE_DIR}/ (${pageCount} timeline page(s))`);
}

main();
