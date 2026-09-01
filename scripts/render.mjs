#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link. No client-side JS.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

const TYPES = ["note", "bookmark", "like", "reply"];
const TYPE_FOLDER = { note: "notes", bookmark: "bookmarks", like: "likes", reply: "replies" };
const SITE_DIR = "_site";
const BASE_URL = "https://posts.rauljimenez.info";

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

const TYPE_LABEL = { note: "Note", bookmark: "Bookmark", like: "Like", reply: "Reply" };

function renderPostHtml({ type, url, properties, content }) {
  const target = targetOf(properties);
  const targetRelClass = { bookmark: "u-bookmark-of", like: "u-like-of", reply: "u-in-reply-to" }[type];
  const published = properties.published || "";
  const title = properties.name || `${TYPE_LABEL[type]} — ${published}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<article class="h-entry">
<p><a class="u-url" href="${escapeHtml(url)}">${escapeHtml(TYPE_LABEL[type])}</a></p>
${published ? `<time class="dt-published" datetime="${escapeHtml(published)}">${escapeHtml(published)}</time>` : ""}
${target ? `<p>${escapeHtml(TYPE_LABEL[type])} of <a class="${targetRelClass}" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>` : ""}
<div class="e-content p-name">${escapeHtml(content)}</div>
<p><a class="p-author h-card" href="https://www.rauljimenez.info/">Raul Jimenez</a></p>
</article>
</body>
</html>
`;
}

async function main() {
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, ".nojekyll"), "");
  await writeFile(path.join(SITE_DIR, "CNAME"), "posts.rauljimenez.info\n");

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

      index.push({ type, url, published: post.properties.published, title: post.properties.name || post.content.slice(0, 80) });
    }
  }

  index.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raul Jimenez — activity</title>
</head>
<body>
<h1>Activity</h1>
<p>Public notes, bookmarks, likes and replies. Source: <a href="https://github.com/hhkaos/posts.rauljimenez.info">hhkaos/posts.rauljimenez.info</a>.</p>
<ul>
${index.map((p) => `<li>${escapeHtml(p.published || "")} — <strong>${escapeHtml(TYPE_LABEL[p.type])}</strong> — <a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></li>`).join("\n")}
</ul>
</body>
</html>
`;
  await writeFile(path.join(SITE_DIR, "index.html"), indexHtml);

  console.log(`Rendered ${index.length} public post(s) into ${SITE_DIR}/`);
}

main();
