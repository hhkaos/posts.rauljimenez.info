#!/usr/bin/env node
// Verifies the microformats2 that Webmention receivers rely on, against the
// actual HTML in `_site/` (not the templates). Run after `render.mjs`.
//
//   - the home page carries a representative h-card (name + url + photo,
//     with a rel="me" link to the same url) so a mention whose source is a
//     bare link list still yields an author;
//   - every post's h-entry / h-event / h-review has an `author` property
//     that parses as a nested h-card with name + url + photo.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { mf2 } from "microformats-parser";

const SITE_DIR = "_site";
const BASE_URL = "https://posts.rauljimenez.info";
const AUTHOR_NAME = "Raúl Jiménez Ortega";
const AUTHOR_URL = "https://www.rauljimenez.info/";
const AUTHOR_PHOTO = "https://www.rauljimenez.info/img/hhkaos-raul-jimenez-ortega.jpeg";

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "  ok  " : " FAIL "} ${message}`);
  if (!condition) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (arr, v) => Array.isArray(arr) && arr.includes(v);

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name === "index.html") out.push(full);
  }
  return out;
}

function urlFor(file) {
  const rel = path.relative(SITE_DIR, file).replace(/\/index\.html$/, "").replace(/index\.html$/, "");
  return rel ? `${BASE_URL}/${rel}` : `${BASE_URL}/`;
}

const files = await htmlFiles(SITE_DIR);

// --- Home page: representative h-card ---
const homeFile = path.join(SITE_DIR, "index.html");
const home = mf2(await readFile(homeFile, "utf8"), { baseUrl: `${BASE_URL}/` });
const repCard = home.items.find((i) => i.type?.includes("h-card"));
console.log("\nHome — representative h-card");
check(!!repCard, "an h-card item exists");
check(eq(repCard?.properties?.name, [AUTHOR_NAME]), `name = ["${AUTHOR_NAME}"]`);
check(has(repCard?.properties?.url, AUTHOR_URL), `url includes ${AUTHOR_URL}`);
check(has(repCard?.properties?.photo, AUTHOR_PHOTO), "photo is the absolute jpeg");
check(has(home.rels?.me, AUTHOR_URL), `rel="me" -> ${AUTHOR_URL}`);

// --- Every post permalink: nested author h-card ---
for (const file of files) {
  if (file === homeFile) continue;
  const url = urlFor(file);
  const doc = mf2(await readFile(file, "utf8"), { baseUrl: url });
  const entry = doc.items.find((i) =>
    ["h-entry", "h-event", "h-review"].some((t) => i.type?.includes(t)));
  if (!entry) continue; // not a post page
  console.log(`\n${url}  [${entry.type.join(",")}]`);
  const author = entry.properties?.author?.[0];
  check(author && typeof author === "object" && author.type?.includes("h-card"),
    "author parses as an embedded h-card");
  check(eq(author?.properties?.name, [AUTHOR_NAME]), `author.name = ["${AUTHOR_NAME}"]`);
  check(eq(author?.properties?.url, [AUTHOR_URL]), `author.url = ["${AUTHOR_URL}"]`);
  check(eq(author?.properties?.photo, [AUTHOR_PHOTO]), "author.photo = the absolute jpeg");
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll microformats2 checks passed");
process.exit(failures ? 1 : 0);
