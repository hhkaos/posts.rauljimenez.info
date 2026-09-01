#!/usr/bin/env node
// Sends outgoing Webmentions for public bookmark/like/reply posts that
// reference an external URL. Only runs after the corresponding page is
// already live on posts.rauljimenez.info (this script runs as the
// `webmentions` job, which `needs: deploy` in the workflow).
//
// Idempotent: keeps a ledger (.webmentions-sent.json) of source|target
// pairs already sent, committed back to the repo by the workflow.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

const TYPE_FOLDER = { bookmark: "bookmarks", like: "likes", reply: "replies" };
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
  return { bookmark: properties["bookmark-of"], like: properties["like-of"], reply: properties["in-reply-to"] }[type];
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

      const visibility = post.properties.visibility || (type === "reply" ? "public" : "private");
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
