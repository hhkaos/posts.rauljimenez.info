#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link. No client-side JS.
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

const TYPES = ["note", "bookmark", "like", "reply"];
const TYPE_FOLDER = { note: "notes", bookmark: "bookmarks", like: "likes", reply: "replies" };
const TYPE_LABEL = { note: "Note", bookmark: "Bookmark", like: "Like", reply: "Reply" };
const TYPE_VERB = { bookmark: "Bookmark of", like: "Like of", reply: "Reply to" };
const SITE_DIR = "_site";
const BASE_URL = "https://posts.rauljimenez.info";
const MAIN_SITE = "https://www.rauljimenez.info/";
const ABOUT_POST = "https://www.rauljimenez.info/blog/first-steps-into-the-indieweb";
const SOURCE_REPO = "https://github.com/hhkaos/posts.rauljimenez.info";

// Mirrors the default applied in indiekit.config.js's postTemplate — kept
// here too so already-published files without an explicit `visibility`
// (e.g. posted before that default existed) still resolve sensibly.
function resolveVisibility(type, properties) {
  if (properties.visibility) return properties.visibility;
  if (type === "bookmark" || type === "like") return "private";
  return "public";
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
    properties["bookmark-of"] || properties["like-of"] || properties["in-reply-to"] || null
  );
}

function targetClassOf(type) {
  return { bookmark: "u-bookmark-of", like: "u-like-of", reply: "u-in-reply-to" }[type];
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
<p class="about">A public feed of notes, bookmarks, likes and replies. Part of an <a href="${ABOUT_POST}">IndieWeb</a> experiment — <a href="${MAIN_SITE}">main site</a> · <a href="${SOURCE_REPO}">source</a>.</p>
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

function renderPostHtml({ type, url, properties, content }) {
  const target = targetOf(properties);
  const published = properties.published || "";

  const body = `
<a class="back" href="${BASE_URL}/">&larr; All activity</a>
<article class="h-entry">
<div class="meta">
<span class="badge ${type}">${escapeHtml(TYPE_LABEL[type])}</span>
${published ? `<time class="dt-published" datetime="${escapeHtml(published)}">${escapeHtml(formatDate(published))}</time>` : ""}
</div>
${target ? `<p class="target">${escapeHtml(TYPE_VERB[type] || "")} <a class="${targetClassOf(type)}" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>` : ""}
<div class="content e-content p-name">${escapeHtml(content)}</div>
<p style="margin-top:1.5rem"><a class="u-url" href="${escapeHtml(url)}">Permalink</a> · <a class="p-author h-card" href="${MAIN_SITE}">Raul Jimenez</a></p>
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

      index.push({
        type,
        url,
        published: post.properties.published,
        title: post.properties.name || post.content.slice(0, 90),
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
