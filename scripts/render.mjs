#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link. No client-side JS.
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
function markdownToPlain(text) {
  return md
    .renderInline(String(text || "").replace(/\r\n/g, "\n").replace(/\n+/g, " "))
    .replace(/<[^>]+>/g, "")
    .trim();
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

// Author identity. Webmention receivers (e.g. webmention.io) extract the
// author of a mention from microformats2: a representative h-card on the
// source page and/or a nested h-card in the h-entry's `author` property.
// Both need name + url + photo, and the photo URL must be absolute.
const AUTHOR_NAME = "Raúl Jiménez Ortega";
const AUTHOR_URL = MAIN_SITE; // https://www.rauljimenez.info/
const AUTHOR_PHOTO = "https://www.rauljimenez.info/img/hhkaos-raul-jimenez-ortega.jpeg";

// Hidden representative h-card — dropped on every page. Its `u-url` is also
// a `rel="me"` link, which is what makes it the *representative* h-card for
// the page (IndieWeb rep-hcard algorithm), so a receiver parsing a page
// with no h-entry (the home page links list) still finds name/photo/url.
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

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// `og` (optional): { url, description, image, type } for a post page.
// `image` is a screenshot generated by scripts/screenshot.mjs; the same
// file is attached as native media when the post is syndicated.
function page({ title, body, og }) {
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
</head>
<body>
<div class="wrap">
<header class="site">
<h1><a href="${BASE_URL}/">Raul Jimenez — activity</a></h1>
<p class="about">A public feed of notes, bookmarks, likes, replies, reposts, RSVPs, events, check-ins, reviews and things read, watched and listened to. Part of an <a href="${ABOUT_POST}">IndieWeb</a> experiment — <a href="${MAIN_SITE}">main site</a> · <a href="${SOURCE_REPO}">source</a>.</p>
</header>
${repHCard()}
${body}
<footer class="site">
<a href="${MAIN_SITE}">www.rauljimenez.info</a>
<a href="${ABOUT_POST}">How this works</a>
<a href="${SOURCE_REPO}">Source on GitHub</a>
</footer>
</div>
</body>
</html>
`;
}

function renderMetaRow(type, published) {
  return `<div class="meta">
<span class="badge ${type}">${escapeHtml(TYPE_LABEL[type])}</span>
${published ? `<time class="dt-published" datetime="${escapeHtml(published)}">${escapeHtml(formatDate(published))}</time>` : ""}
</div>`;
}

function renderPermalink(url) {
  return `<p style="margin-top:1.5rem"><a class="u-url" href="${escapeHtml(url)}">Permalink</a> · ${authorHCard()}</p>`;
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
} · ${authorHCard()}</p>
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
${renderPermalink(url)}
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
${renderPermalink(url)}
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
${renderPermalink(url)}
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
${renderPermalink(url)}
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
${renderPermalink(url)}
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
${renderPermalink(url)}
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

// Feed-list title + optional external target (for the "→ hostname" suffix,
// which must be an absolute URL) for one post.
function indexEntry(type, properties, content) {
  const bodyTitle = markdownToPlain(content).slice(0, 90);
  const named = properties.name || bodyTitle || TYPE_LABEL[type];

  switch (type) {
    case "rsvp":
      return {
        title: `${properties.rsvp ? `[${properties.rsvp}] ` : ""}${named}`,
        target: targetOf(properties),
      };
    case "checkin":
      return { title: `📍 ${cite(properties.checkin).name || named}`, target: citeUrl(properties.checkin) || null };
    case "review": {
      const it = cite(properties.item);
      const r = Number(properties.rating);
      return {
        title: `${properties.name || `Review of ${it.name || "something"}`}${Number.isFinite(r) ? ` (${r}/5)` : ""}`,
        target: citeUrl(properties.item) || null,
      };
    }
    case "read":
    case "watch":
    case "listen": {
      const spec = CONSUMED[type];
      const w = cite(properties[spec.prop]);
      const status = spec.statusProp ? String(properties[spec.statusProp] || "").toLowerCase() : "";
      const verb = status ? (READ_STATUS_LABEL[status] || spec.verb) : spec.verb;
      return { title: `${spec.icon} ${verb} ${w.name || "something"}`, target: citeUrl(properties[spec.prop]) || null };
    }
    default:
      return { title: named, target: targetOf(properties) };
  }
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
      const { title, target } = indexEntry(effectiveType, props, post.content);
      index.push({ type: effectiveType, url, published: props.published, title, target });
    }
  }

  index.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  const listItems = index.map((p) => `<li>
<div class="meta">
<span class="badge ${p.type}">${escapeHtml(TYPE_LABEL[p.type])}</span>
<time datetime="${escapeHtml(p.published || "")}">${escapeHtml(formatDate(p.published))}</time>
</div>
<a class="title" href="${escapeHtml(p.url)}">${escapeHtml(p.title)}${p.target ? ` &rarr; ${escapeHtml(new URL(p.target).hostname)}` : ""}</a>
</li>`).join("\n");

  const indexBody = index.length
    ? `<ul class="feed">\n${listItems}\n</ul>`
    : `<p>Nothing public yet.</p>`;

  await writeFile(path.join(SITE_DIR, "index.html"), page({ title: "Raul Jimenez — activity", body: indexBody }));

  console.log(`Rendered ${index.length} public post(s) into ${SITE_DIR}/`);
}

main();
