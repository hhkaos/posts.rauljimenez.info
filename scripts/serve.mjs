#!/usr/bin/env node
// Local preview server for the rendered `_site/`. Not used in production
// (GitHub Pages serves the deployed artifact) — just for seeing changes
// before pushing.
//
//   node scripts/serve.mjs             serve _site/ on http://localhost:8787
//   node scripts/serve.mjs --watch     also re-run render.mjs when scripts/
//                                       or any content folder changes
//   PORT=4000 node scripts/serve.mjs   pick the port
//   HOST=0.0.0.0 npm run dev           reachable from other machines on the
//                                       LAN (links use this box's IP; set
//                                       PREVIEW_HOST to override the IP)
//
// `npm run dev` == `serve.mjs --watch`: builds once, serves, and rebuilds on
// change. `npm run serve` just serves whatever is already in `_site/`.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, watch } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SITE_DIR = "_site";
const PORT = Number(process.env.PORT) || 8787;
// Bind to loopback by default. Set HOST=0.0.0.0 to reach the preview from
// another machine on the LAN (e.g. `HOST=0.0.0.0 npm run dev`).
const HOST = process.env.HOST || "127.0.0.1";

// The hostname that goes into PREVIEW_BASE (so internal links / feed URLs
// resolve for whoever opens the preview). When bound to the LAN, that must
// be this machine's IP, not "localhost". Override with PREVIEW_HOST.
function lanIP() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) addrs.push(i.address);
    }
  }
  return (
    addrs.find((a) => a.startsWith("192.168.")) ||
    addrs.find((a) => a.startsWith("10.")) ||
    addrs[0] ||
    "localhost"
  );
}
const PREVIEW_HOST =
  process.env.PREVIEW_HOST ||
  (HOST !== "127.0.0.1" && HOST !== "localhost" ? lanIP() : "localhost");
const WATCH = process.argv.includes("--watch");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent(request.url.split("?")[0]);
    let filePath = path.join(SITE_DIR, urlPath);
    if (!path.resolve(filePath).startsWith(path.resolve(SITE_DIR))) {
      response.writeHead(403);
      return response.end("Forbidden");
    }
    if ((await stat(filePath).catch(() => null))?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>404</h1><p>Not found. Have you run <code>npm run build</code>?</p>");
  }
});

// If the port is taken, step forward until one is free (up to +20), so a
// stray service on this machine doesn't block the preview.
let attempts = 0;
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && attempts < 20) {
    attempts++;
    server.listen(PORT + attempts, HOST);
  } else {
    console.error(`  serve: ${error.message}`);
    process.exit(1);
  }
});
server.on("listening", async () => {
  const { port } = server.address();
  console.log(`\n  Preview:  http://${PREVIEW_HOST}:${port}/\n`);
  // Always re-render for the real port so every internal link / feed URL
  // points at this preview, not production — whatever `_site/` held before
  // (e.g. a prior `npm run build` with canonical URLs). `--watch` then only
  // adds the rebuild-on-change loop.
  await render(port);
  if (WATCH) startWatch(port);
});
server.listen(PORT, HOST);

// --- optional rebuild-on-change ------------------------------------------

function render(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", ["scripts/render.mjs"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PREVIEW_BASE: `http://${PREVIEW_HOST}:${port}` },
    });
    child.on("exit", (code) => {
      console.log(code === 0 ? `  rebuilt in ${Date.now() - started}ms` : `  render failed (exit ${code})`);
      resolve();
    });
  });
}

function startWatch(port) {
  // Content folders + the render/style sources. New top-level folders are
  // rare enough that restarting the server to pick them up is fine.
  const targets = [
    "scripts", "media",
    "notes", "articles", "photos", "bookmarks", "likes", "replies", "rsvp",
    "reposts", "events", "checkins", "reviews", "reads", "watches", "listens",
  ];
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => render(port), 150);
  };

  console.log("  watching for changes (Ctrl+C to stop)…\n");
  for (const dir of targets) {
    (async () => {
      try {
        for await (const _event of watch(dir, { recursive: true })) schedule();
      } catch {
        /* folder doesn't exist yet — ignore */
      }
    })();
  }
}
