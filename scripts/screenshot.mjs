#!/usr/bin/env node
// Screenshots every rendered post page into `_site/<path>/screenshot.png`
// at Open Graph proportions (1200×630). The Indiekit syndicators fetch
// `{permalink}/screenshot.png` and attach it as native media on Mastodon
// and Bluesky; the same file is referenced as `og:image` by render.mjs.
//
// Runs in CI after render.mjs. Serves `_site/` over localhost first so the
// pages' absolute `/style.css` resolves.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const SITE_DIR = "_site";
const WIDTH = 1200;
const HEIGHT = 630;
const PORT = 4173;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function findPostPages(dir, base = "") {
  const pages = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      pages.push(...(await findPostPages(path.join(dir, entry.name), `${base}/${entry.name}`)));
    } else if (entry.name === "index.html" && base.split("/").length === 6) {
      // post pages live at /<type>/<yyyy>/<MM>/<dd>/<slug>/index.html
      pages.push({ urlPath: `${base}/`, dir });
    }
  }
  return pages;
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(request.url.split("?")[0]);
      let filePath = path.join(SITE_DIR, urlPath);
      if ((await stat(filePath).catch(() => null))?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  const pages = await findPostPages(SITE_DIR);
  if (pages.length === 0) {
    console.log("screenshot: no post pages found");
    return;
  }

  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });

  // Trim the site chrome so the post itself fills the card.
  const cardCss = `
    header.site .about, a.back, footer.site { display: none !important; }
    header.site { margin-bottom: 1.25rem; padding-bottom: 0.75rem; }
    .wrap { padding: 2rem 2.5rem; max-width: none; }
    article .content { overflow: hidden; }
  `;

  let count = 0;
  for (const { urlPath, dir } of pages) {
    await page.goto(`http://localhost:${PORT}${urlPath}`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: cardCss });
    await page.screenshot({
      path: path.join(dir, "screenshot.png"),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    count++;
  }

  await browser.close();
  server.close();
  console.log(`screenshot: wrote ${count} image(s)`);
}

main();
