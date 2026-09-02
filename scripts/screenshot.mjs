#!/usr/bin/env node
// Screenshots every rendered post page into `_site/<path>/screenshot.png`.
// The Indiekit syndicators fetch `{permalink}/screenshot.png` and attach it
// as native media on Mastodon and Bluesky; the same file is referenced as
// `og:image` by render.mjs.
//
// Also writes `_site/social-card.png` — a 1200×630 shot of the landing page
// (the size every network recommends for og:image), used as the site-level
// og:image on the timeline, /about/ and as the per-post fallback.
//
// The image is 1200 wide and cropped to the post card's real height rather
// than a fixed 1200×630, so a short post (an RSVP, a like, a one-line note)
// no longer sits in a sea of white space — which is what made the
// syndicated images look empty and, on Bluesky's square-ish crop, cut off.
// Height is clamped between ~2.2:1 (a landscape floor that keeps the file
// usable as an Open Graph image) and 1:1 (a cap so a very long note doesn't
// produce a skyscraper); when the card is shorter than the floor it's
// centred vertically so the frame reads as deliberate rather than top-heavy.
//
// Runs in CI after render.mjs. Serves `_site/` over localhost first so the
// pages' absolute `/style.css` resolves.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const SITE_DIR = "_site";
const WIDTH = 1200;
const MIN_HEIGHT = Math.round(WIDTH / 2.2); // 545 — never wider than ~2.2:1
const MAX_HEIGHT = WIDTH; //                    1200 — never taller than 1:1
const PAD_BOTTOM = 12; // small safety margin below the card's own padding
const PORT = 4173;
const CARD = { width: 1200, height: 630 }; // og:image recommended size

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

// The site-level social card: the landing page as-is (navbar, intro, the
// first cards), widened a little so the column fills the 1200×630 frame.
async function shootSocialCard(browser) {
  const card = await browser.newPage({
    viewport: CARD, // deviceScaleFactor 1 → the file is exactly 1200×630
    colorScheme: "light",
  });
  await card.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await card.addStyleTag({
    content: `
      .wrap { max-width: 1000px; padding-top: 1.5rem; }
      footer.site, #timeline-end, .pager { display: none !important; }
    `,
  });
  await card.evaluate(() => document.fonts.ready.then(() => undefined));
  await card.screenshot({
    path: path.join(SITE_DIR, "social-card.png"),
    clip: { x: 0, y: 0, ...CARD },
  });
  await card.close();
  console.log("screenshot: wrote social-card.png");
}

async function main() {
  const pages = await findPostPages(SITE_DIR);

  const server = await startServer();
  const browser = await chromium.launch();

  await shootSocialCard(browser);

  if (pages.length === 0) {
    await browser.close();
    server.close();
    console.log("screenshot: no post pages found");
    return;
  }

  const page = await browser.newPage({
    // Start tall so a long post lays out fully before we measure it; the
    // real crop height is set per page below.
    viewport: { width: WIDTH, height: MAX_HEIGHT },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });

  // Trim the site chrome so the post itself fills the card.
  const cardCss = `
    nav.site-nav, header.site, a.back, footer.site, .webmentions { display: none !important; }
    body { padding-top: 0 !important; }
    .wrap { padding: 2rem 2.5rem; max-width: none; }
    article .content { overflow: hidden; }
    /* Keep a big image from turning the card into a skyscraper — photo
       posts syndicate the real photo, this is just the OG fallback. */
    article img { max-height: 520px; width: auto; object-fit: contain; }
  `;

  let count = 0;
  for (const { urlPath, dir } of pages) {
    await page.setViewportSize({ width: WIDTH, height: MAX_HEIGHT });
    await page.goto(`http://localhost:${PORT}${urlPath}`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: cardCss });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Measure the card's real height (`.wrap` carries the visible chrome +
    // the post), then crop to it, clamped to the landscape floor / square
    // cap. If the floor adds slack, push the card down by half of it so the
    // whitespace is split top and bottom rather than dumped below.
    const cardBottom = await page.evaluate(() => {
      const wrap = document.querySelector(".wrap");
      return wrap ? Math.ceil(wrap.getBoundingClientRect().bottom) : 0;
    });
    const height = Math.min(
      Math.max(cardBottom + PAD_BOTTOM, MIN_HEIGHT),
      MAX_HEIGHT,
    );
    const slack = height - PAD_BOTTOM - cardBottom;
    if (slack > 0) {
      await page.addStyleTag({
        content: `body { padding-top: ${Math.round(slack / 2)}px; }`,
      });
    }

    await page.setViewportSize({ width: WIDTH, height });
    await page.screenshot({
      path: path.join(dir, "screenshot.png"),
      clip: { x: 0, y: 0, width: WIDTH, height },
    });
    count++;
  }

  await browser.close();
  server.close();
  console.log(`screenshot: wrote ${count} image(s)`);
}

main();
