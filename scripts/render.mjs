#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link. No client-side JS.
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

const TYPES = ["note", "bookmark", "like", "reply", "rsvp", "repost", "event"];
const TYPE_FOLDER = {
  note: "notes", bookmark: "bookmarks", like: "likes", reply: "replies",
  rsvp: "rsvp", repost: "reposts", event: "events",
};
const TYPE_LABEL = {
  note: "Note", bookmark: "Bookmark", like: "Like", reply: "Reply",
  rsvp: "RSVP", repost: "Repost", event: "Event",
};
const TYPE_VERB = {
  bookmark: "Bookmark of", like: "Like of", reply: "Reply to",
  rsvp: "RSVP to", repost: "Repost of",
};
const SITE_DIR = "_site";
const BASE_URL = "https://posts.rauljimenez.info";
const MAIN_SITE = "https://www.rauljimenez.info/";
const ABOUT_POST = "https://www.rauljimenez.info/blog/first-steps-into-the-indieweb";
const SOURCE_REPO = "https://github.com/hhkaos/posts.rauljimenez.info";

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

function page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap">
<header class="site">
<h1><a href="${BASE_URL}/">Raul Jimenez — activity</a></h1>
<p class="about">A public feed of notes, bookmarks, likes, replies, reposts, RSVPs and events. Part of an <a href="${ABOUT_POST}">IndieWeb</a> experiment — <a href="${MAIN_SITE}">main site</a> · <a href="${SOURCE_REPO}">source</a>.</p>
</header>
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
  return `<p style="margin-top:1.5rem"><a class="u-url" href="${escapeHtml(url)}">Permalink</a> · <a class="p-author h-card" href="${MAIN_SITE}">Raul Jimenez</a></p>`;
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
${content ? `<div class="content e-content">${escapeHtml(content)}</div>` : ""}
<p style="margin-top:1.5rem">${
  eventUrl
    ? `<a href="${escapeHtml(url)}">Permalink</a>`
    : `<a class="u-url" href="${escapeHtml(url)}">Permalink</a>`
} · <a class="p-author h-card" href="${MAIN_SITE}">Raul Jimenez</a></p>
</article>`;

  return page({ title: name, body });
}

function renderPostHtml({ type, url, properties, content }) {
  if (type === "event") return renderEventHtml({ url, properties, content });

  const target = targetOf(properties);
  const published = properties.published || "";
  const rsvp = type === "rsvp" ? properties.rsvp : "";

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
${renderMetaRow(type, published)}
${rsvp ? `<p class="rsvp-answer">RSVP: <data class="p-rsvp" value="${escapeHtml(rsvp)}">${escapeHtml(rsvp)}</data></p>` : ""}
${target ? `<p class="target">${escapeHtml(TYPE_VERB[type] || "")} <a class="${targetClassOf(type)}" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>` : ""}
<div class="content e-content p-name">${escapeHtml(content)}</div>
${renderPermalink(url)}
</article>`;

  return page({ title: properties.name || `${TYPE_LABEL[type]} — ${formatDate(published)}`, body });
}

async function main() {
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, ".nojekyll"), "");
  await writeFile(path.join(SITE_DIR, "CNAME"), "posts.rauljimenez.info\n");
  await copyFile("scripts/style.css", path.join(SITE_DIR, "style.css"));

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

      const rsvpPrefix = type === "rsvp" && post.properties.rsvp ? `[${post.properties.rsvp}] ` : "";
      index.push({
        type,
        url,
        published: post.properties.published,
        title: rsvpPrefix + (post.properties.name || post.content.slice(0, 90) || TYPE_LABEL[type]),
        target: targetOf(post.properties),
      });
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
