#!/usr/bin/env node
// Build-time geocoder for posts that carry a postal address but no
// coordinates — in practice `event` posts, whose `location` is an h-adr
// (street-address / locality / … and no lat/lon). Uses the ArcGIS World
// Geocoding Service, authenticated with an OAuth2 client-credentials app.
//
// Results are cached in `.geocode-cache.json` at the repo root, keyed on
// the exact single-line address, so within a build each address is sent
// once. That file is currently **git-ignored** (see `forStorage` below), so
// every build re-geocodes its handful of addresses — cheap, and it keeps us
// off ArcGIS's storage licensing. If it's ever committed instead, flip
// `forStorage` to "true" (that consumes credits) so the persisted
// coordinates are licensed.
//
// Credentials (both needed for a live call; absent → the address just
// doesn't get a map point, no error):
//   ARCGIS_CLIENT_ID, ARCGIS_CLIENT_SECRET
// Set them as GitHub Actions repo secrets for the deploy build, and/or in a
// git-ignored `.env` for local runs (render.mjs loads `.env`).

import { readFile, writeFile } from "node:fs/promises";

const CACHE_FILE = ".geocode-cache.json";
const TOKEN_URL = "https://www.arcgis.com/sharing/rest/oauth2/token";
const GEOCODE_URL =
  "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";
// A candidate below this match score (0–100) is treated as "not found"
// rather than dropping a pin in the wrong place.
const MIN_SCORE = 80;

let cache = null;
let dirty = false;
let tokenPromise = null;
let warned = false;

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

// Write the cache back if this run added anything. Keys are sorted so the
// committed diff stays readable.
export async function saveGeocodeCache() {
  if (!dirty || !cache) return;
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(CACHE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  dirty = false;
}

function getToken() {
  if (tokenPromise) return tokenPromise;
  const id = process.env.ARCGIS_CLIENT_ID;
  const secret = process.env.ARCGIS_CLIENT_SECRET;
  if (!id || !secret) return Promise.resolve(null);
  tokenPromise = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "client_credentials",
        f: "json",
      }),
    });
    const json = await res.json();
    if (!json.access_token) {
      throw new Error(`ArcGIS token request failed: ${JSON.stringify(json)}`);
    }
    return json.access_token;
  })();
  return tokenPromise;
}

// Geocode an address given as an ordered list of fragments (falsy entries
// are dropped, the rest joined with ", "). Returns { lat, lon } or null.
export async function geocode(parts) {
  const singleLine = parts.filter(Boolean).join(", ").trim();
  if (!singleLine) return null;

  const store = await loadCache();
  if (Object.prototype.hasOwnProperty.call(store, singleLine)) {
    const hit = store[singleLine];
    return hit && hit.lat != null ? { lat: hit.lat, lon: hit.lon } : null;
  }

  let token;
  try {
    token = await getToken();
  } catch (err) {
    console.warn(`  geocode: ${err.message}`);
    return null;
  }
  if (!token) {
    if (!warned) {
      console.warn(
        "  geocode: ARCGIS_CLIENT_ID / ARCGIS_CLIENT_SECRET not set — " +
          `address-only locations won't be mapped (e.g. "${singleLine}")`,
      );
      warned = true;
    }
    return null; // not cached — a later run with credentials should retry
  }

  const url = new URL(GEOCODE_URL);
  url.search = new URLSearchParams({
    f: "json",
    singleLine,
    maxLocations: "1",
    outFields: "Match_addr",
    // "false" = single-use, not persisted (no credit cost). The cache is
    // git-ignored to match. Set "true" only if the cache gets committed —
    // storing coordinates requires it and consumes credits.
    forStorage: "false",
    token,
  }).toString();

  const res = await fetch(url);
  const json = await res.json();
  if (json.error) {
    console.warn(`  geocode: "${singleLine}" → ArcGIS error ${JSON.stringify(json.error)}`);
    return null; // transient / auth — don't poison the cache
  }
  const cand = json.candidates && json.candidates[0];
  const ok = cand && cand.score >= MIN_SCORE && cand.location;

  store[singleLine] = ok
    ? {
        lat: round(cand.location.y),
        lon: round(cand.location.x),
        score: cand.score,
        matchAddr: cand.attributes?.Match_addr || cand.address || "",
        geocodedAt: new Date().toISOString(),
      }
    : { lat: null, lon: null, score: cand?.score ?? 0, geocodedAt: new Date().toISOString() };
  dirty = true;

  console.log(
    ok
      ? `  geocode: "${singleLine}" → ${store[singleLine].lat},${store[singleLine].lon} (score ${cand.score})`
      : `  geocode: "${singleLine}" → no confident match`,
  );
  return ok ? { lat: store[singleLine].lat, lon: store[singleLine].lon } : null;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}
