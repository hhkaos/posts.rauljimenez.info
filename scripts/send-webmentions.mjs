#!/usr/bin/env node
// Sends outgoing Webmentions for public posts that reference an external
// URL: bookmark/like/reply/rsvp/repost, plus review (→ the reviewed item)
// and read/watch/listen (→ the cited work, if it has a real URL). Events
// and check-ins are NOT sent: an h-event announces something rather than
// responding to a page, and a check-in's venue URL isn't a mention target.
// Only runs after the corresponding page is already live on
// posts.rauljimenez.info (this script runs as the `webmentions` job, which
// `needs: deploy` in the workflow).
//
// Idempotent: keeps a ledger (.webmentions-sent.json) of source|target
// pairs already sent, committed back to the repo by the workflow.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

const TYPE_FOLDER = {
  bookmark: "bookmarks", like: "likes", reply: "replies",
  rsvp: "rsvp", repost: "reposts",
  review: "reviews", read: "reads", watch: "watches", listen: "listens",
};

// checkin / item / read-of / watch-of / listen-of are stored as a nested
// map ({ type, name, url, … }). Return an absolute http(s) URL or null.
function citeUrl(value) {
  if (!value || typeof value === "string") return null;
  const p = value.properties || value;
  const url = Array.isArray(p.url) ? p.url[0] : p.url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
}
const BASE_URL = "https://posts.rauljimenez.info";
const LEDGER_PATH = ".webmentions-sent.json";

function parsePost(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  return { properties: YAML.parse(match[1]) || {} };
}

function slugAndDateFromFilename(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/);
  if (!match) return null;
  const [, yyyy, MM, dd, slug] = match;
  return { yyyy, MM, dd, slug };
}

function targetOf(type, properties) {
  return {
    bookmark: properties["bookmark-of"],
    like: properties["like-of"],
    reply: properties["in-reply-to"],
    rsvp: properties["in-reply-to"],
    repost: properties["repost-of"],
    review: citeUrl(properties.item),
    read: citeUrl(properties["read-of"]),
    watch: citeUrl(properties["watch-of"]),
    listen: citeUrl(properties["listen-of"]),
  }[type];
}

async function loadLedger() {
  try {
    return JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function parseLinkHeader(header) {
  if (!header) return [];
  const uris = [];
  for (const value of header.split(/,(?=\s*<)/)) {
    const m = value.match(/<([^>]*)>\s*;\s*(.*)/s);
    if (!m) continue;
    const [, uri, params] = m;
    const relMatch = params.match(/rel\s*=\s*"?([^";]+)"?/i);
    if (relMatch?.[1]?.trim().split(/\s+/).includes("webmention")) uris.push(uri);
  }
  return uris;
}

async function discoverWebmentionEndpoint(targetUrl) {
  let response;
  try {
    response = await fetch(targetUrl, { headers: { accept: "text/html" }, redirect: "follow" });
  } catch (error) {
    console.log(`  fetch failed: ${error.message}`);
    return null;
  }
  if (!response.ok) {
    console.log(`  target returned HTTP ${response.status}`);
    return null;
  }

  const fromHeader = parseLinkHeader(response.headers.get("link"));
  if (fromHeader[0]) return new URL(fromHeader[0], targetUrl).href;

  const body = await response.text();
  const linkMatch = body.match(/<link[^>]+rel=["'][^"']*webmention[^"']*["'][^>]*>/i)
    || body.match(/<a[^>]+rel=["'][^"']*webmention[^"']*["'][^>]*>/i);
  if (!linkMatch) return null;

  const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
  return hrefMatch ? new URL(hrefMatch[1], targetUrl).href : null;
}

async function sendWebmention(endpoint, source, target) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ source, target }).toString(),
  });
  return response;
}

async function main() {
  const ledger = await loadLedger();
  let sent = 0;
  let changed = false;

  for (const [type, folder] of Object.entries(TYPE_FOLDER)) {
    let filenames = [];
    try {
      filenames = (await readdir(folder)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const filename of filenames) {
      const parsedName = slugAndDateFromFilename(filename);
      if (!parsedName) continue;

      const raw = await readFile(path.join(folder, filename), "utf8");
      const post = parsePost(raw);
      if (!post) continue;

      // Mirrors indiekit.config.js: no explicit visibility means public.
      const visibility = post.properties.visibility || "public";
      if (visibility !== "public") continue;

      const target = targetOf(type, post.properties);
      if (!target) continue;

      const { yyyy, MM, dd, slug } = parsedName;
      const source = `${BASE_URL}/${folder}/${yyyy}/${MM}/${dd}/${slug}`;
      const ledgerKey = `${source}|${target}`;
      if (ledger[ledgerKey]) continue;

      console.log(`${source} -> ${target}`);
      const endpoint = await discoverWebmentionEndpoint(target);
      if (!endpoint) {
        console.log("  no webmention endpoint declared by target, skipping");
        continue;
      }

      console.log(`  endpoint: ${endpoint}`);
      const response = await sendWebmention(endpoint, source, target);
      console.log(`  HTTP ${response.status}`);

      if (response.ok || response.status === 201 || response.status === 202) {
        ledger[ledgerKey] = { sentAt: new Date().toISOString(), status: response.status };
        changed = true;
        sent++;
      }
    }
  }

  if (changed) {
    await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
  }

  console.log(`Sent ${sent} new webmention(s).`);
}

main();
