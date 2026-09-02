#!/usr/bin/env node
// Renders public posts (see `resolveVisibility` below) as static HTML into
// `_site/`, for GitHub Pages (posts.rauljimenez.info). Not a general-purpose
// static site generator — just enough markup for a Webmention receiver (and
// a human) to find the post and its target link.
//
// The timeline is split into numbered pages (`/`, `/page/2/`, …) that work
// on their own; `scripts/timeline.js` is one small progressive-enhancement
// script that turns them into infinite scroll when JS is available. An Atom
// feed is written to `/feed.xml`, and `/about/` explains what this is.
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { franc } from "franc-min";
import MarkdownIt from "markdown-it";
import YAML from "yaml";

// Post bodies are authored as Markdown (that's what Indiekit's postTemplate
// writes). `linkify` turns bare URLs into links; `breaks` keeps single
// newlines as <br>, matching how short notes are written. `html: false`
// means any literal HTML in a body is escaped, not passed through.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function renderMarkdown(text) {
  return md.render(String(text || "").replace(/\r\n/g, "\n")).trim();
}

// Markdown reduced to a single line of plain text, for list titles etc.
// Tags are stripped and the handful of entities markdown-it emits are
// decoded, so the result is real text safe to re-escape by the caller.
function decodeBasicEntities(string) {
  return string.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'",
  }[e]));
}
function markdownToPlain(text) {
  return decodeBasicEntities(
    md
      .renderInline(String(text || "").replace(/\r\n/g, "\n").replace(/\n+/g, " "))
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

const TYPES = [
  "note", "article", "photo", "bookmark", "like", "reply", "rsvp", "repost",
  "event", "checkin", "review", "read", "watch", "listen",
];
const TYPE_FOLDER = {
  note: "notes", article: "articles", photo: "photos", bookmark: "bookmarks",
  like: "likes", reply: "replies", rsvp: "rsvp", repost: "reposts",
  event: "events", checkin: "checkins", review: "reviews", read: "reads",
  watch: "watches", listen: "listens",
};
const TYPE_LABEL = {
  note: "Note", article: "Article", photo: "Photo", bookmark: "Bookmark",
  like: "Like", reply: "Reply", rsvp: "RSVP", repost: "Repost",
  event: "Event", checkin: "Check-in", review: "Review", read: "Read",
  watch: "Watch", listen: "Listen",
};
const TYPE_VERB = {
  bookmark: "Bookmark of", like: "Like of", reply: "Reply to",
  rsvp: "RSVP to", repost: "Repost of",
};

// checkin / item / read-of / watch-of / listen-of are stored in the front
// matter as a nested map ({ type, name, url, author, latitude, … }); a
// bare string is tolerated as a name-only fallback.
function cite(value) {
  if (!value) return {};
  if (typeof value === "string") return { name: value };
  return value.properties || value;
}
function citeUrl(value) {
  const url = cite(value).url;
  const first = Array.isArray(url) ? url[0] : url;
  return typeof first === "string" && /^https?:\/\//.test(first) ? first : "";
}
const SITE_DIR = "_site";
// The live site. Override with PREVIEW_BASE (e.g. http://localhost:8000) for
// local preview so permalinks/feed links resolve to the local server — never
// set it for the CI build that actually deploys.
const CANONICAL_BASE = "https://posts.rauljimenez.info";
const BASE_URL = process.env.PREVIEW_BASE || CANONICAL_BASE;
// The production URL for a page, even under PREVIEW_BASE — webmention lookups
// are always keyed on the real canonical URL, never the localhost preview one.
const toCanonical = (u) =>
  BASE_URL !== CANONICAL_BASE && u.startsWith(BASE_URL)
    ? CANONICAL_BASE + u.slice(BASE_URL.length)
    : u;
// The shared webmention.io endpoint (the `links.rauljimenez.info` account).
// Advertised in every page's <head> and posted to by the "Respond" form.
const WEBMENTION_ENDPOINT =
  "https://webmention.io/links.rauljimenez.info/webmention";
const MAIN_SITE = "https://www.rauljimenez.info/";
const MAIN_SITE_ES = "https://www.rauljimenez.info/es/";
const ABOUT_POST = "https://www.rauljimenez.info/blog/first-steps-into-the-indieweb";
const SOURCE_REPO = "https://github.com/hhkaos/posts.rauljimenez.info";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

// Timeline pagination. Overridable via env so pagination can be exercised
// locally without hundreds of posts.
const PAGE_SIZE = Number(process.env.TIMELINE_PAGE_SIZE) || 20;
// Atom feed: newest N entries only.
const FEED_MAX = 50;

// Navbar — a faithful mirror of the Docusaurus navbar on www.rauljimenez.info
// so the two sites read as one. The logo is hotlinked from the main site
// (same owner); vendor it into this repo if that dependency is unwanted.
const LOGO_URL = "https://www.rauljimenez.info/img/rauljimenez.info.png";
// Labels + hrefs mirror the main site's own navbar in each language, so a
// visitor arriving from the Spanish site keeps Spanish chrome (see the
// [data-lang] handling in HEAD_INIT_SCRIPT + style.css).
const NAV_LINKS = [
  {
    label: "🧠 Digital Brain", href: "https://www.rauljimenez.info/docs/digital-brain",
    es: { label: "🧠 Mi cerebro digital", href: "https://www.rauljimenez.info/es/docs/digital-brain" },
  },
  {
    label: "📝 Blog", href: "https://www.rauljimenez.info/blog",
    es: { label: "📝 Blog", href: "https://www.rauljimenez.info/es/blog" },
  },
  {
    label: "📡 Activity", href: `${BASE_URL}/`, current: true,
    es: { label: "📡 Actividad", href: `${BASE_URL}/` },
  },
  {
    label: "🤓 About me", href: "https://www.rauljimenez.info/docs/category/-about-me",
    es: { label: "🤓 Sobre mí", href: "https://www.rauljimenez.info/es/docs/category/-about-me" },
  },
];

// Author identity. Webmention receivers (e.g. webmention.io) extract the
// author of a mention from microformats2: a representative h-card on the
// source page and/or a nested h-card in the h-entry's `author` property.
// Both need name + url + photo, and the photo URL must be absolute.
const AUTHOR_NAME = "Raúl Jiménez Ortega";
const AUTHOR_URL = MAIN_SITE; // https://www.rauljimenez.info/
const AUTHOR_PHOTO = "https://www.rauljimenez.info/img/hhkaos-raul-jimenez-ortega.jpeg";

// <title> / og:title — always branded with the full name, matching
// www.rauljimenez.info ("Raúl Jiménez Ortega | …").
function fullTitle(t) {
  return t ? `${AUTHOR_NAME} | ${t}` : AUTHOR_NAME;
}

// Social sharing. Every page gets Open Graph + Twitter tags; pages that
// don't set their own image fall back to SOCIAL_CARD — a 1200×630 shot of
// the landing page written by screenshot.mjs (the size every network
// recommends for og:image).
const SOCIAL_CARD = `${BASE_URL}/social-card.png`;
const SOCIAL_CARD_ALT = "The activity feed at posts.rauljimenez.info — Raúl Jiménez Ortega";
const SITE_DESCRIPTION =
  "Notes, links, photos, events, reviews and things I've read, watched and listened to — self-hosted on my own domain, following the IndieWeb approach, not on a social platform.";
const OG_LOCALE = { en: "en_US", es: "es_ES" };

// Hidden representative h-card — dropped on every *post* page (not the
// index, see `page()`). Its `u-url` is also a `rel="me"` link, which makes
// it the representative h-card per the IndieWeb rep-hcard algorithm.
function repHCard() {
  return `<div class="h-card" hidden>
<a class="p-name u-url" href="${AUTHOR_URL}" rel="me">${escapeHtml(AUTHOR_NAME)}</a>
<img class="u-photo" src="${AUTHOR_PHOTO}" alt="">
</div>`;
}

// Nested author h-card for an h-entry / h-event / h-review. Not shown — the
// site has one author (me) on every post, so a visible byline is noise — but
// kept in the markup (hidden) as an explicit `author` property so Webmention
// consumers that read a mention's author from mf2 still get name/url/photo.
function authorHCard() {
  return `<span class="p-author h-card" hidden><a class="p-name u-url" href="${AUTHOR_URL}" rel="author">${escapeHtml(AUTHOR_NAME)}</a><img class="u-photo" src="${AUTHOR_PHOTO}" alt=""></span>`;
}

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

// Language of the site's own furniture (feed metadata, /about/ prose) and
// the fallback for a post whose language can't be told. Posts are written
// in either Spanish or English; nothing else is distinguished.
const SITE_DEFAULT_LANG = "en";

// Content language of one post, used for `<html lang>` / `xml:lang` / the
// per-card `lang` on the timeline, and to aim the "translate" link. An
// explicit `lang:` in the front matter always wins (that's the manual
// override for when detection is wrong, or for very short posts); otherwise
// `franc` guesses offline — no API — restricted to es/en, and anything it
// can't call confidently falls back to the site default.
function postLang(properties, content) {
  const explicit = String(properties.lang || "").trim().toLowerCase().slice(0, 2);
  if (explicit === "es" || explicit === "en") return explicit;
  const code = franc(markdownToPlain(content || ""), { only: ["spa", "eng"], minLength: 12 });
  if (code === "spa") return "es";
  if (code === "eng") return "en";
  return SITE_DEFAULT_LANG;
}

// "Translate this post" link. Browsers don't expose their built-in page
// translation to JS, so this points at Google Translate's page proxy —
// free, no key. Label + target language are the *other* of es/en, so it
// reads to the person who needs it. Empty when the language is unknown.
function translateLink(url, lang) {
  if (lang !== "es" && lang !== "en") return "";
  const to = lang === "es" ? "en" : "es";
  const label = lang === "es" ? "See in English" : "Ver en español";
  // Always the canonical URL — Google Translate can't fetch a localhost preview.
  const href = `https://translate.google.com/translate?sl=${lang}&tl=${to}&u=${encodeURIComponent(toCanonical(url))}`;
  return `<a class="translate-link" href="${escapeHtml(href)}" hreflang="${to}" rel="nofollow noopener">🌐 ${label}</a>`;
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

// Times are shown in the author's timezone (posts carry a UTC `published`).
const TZ = "Europe/Madrid";

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// "2 Sep 2026, 21:57" — used on post pages and (date part) as the feed
// day heading; the feed cards themselves show just the time.
function formatDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-GB", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    return `${date}, ${time}`;
  } catch {
    return iso;
  }
}

function feedTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function feedDay(iso) {
  if (!iso) return "Undated";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "Undated";
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Body reduced to a plain-text snippet for feed cards (images/links stripped).
function excerptOf(text, max = 190) {
  const plain = markdownToPlain(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

// First inline Markdown image in a body — lets reviews / reads / notes show
// their illustration in the feed (photo posts use `properties.photo`).
function firstContentImage(text) {
  const m = String(text || "").match(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/);
  return m ? { url: m[2], alt: m[1] || "" } : null;
}

// "20–23 Oct 2026" when start/end share a month, else "20 Oct – 23 Oct 2026".
function formatDateRange(start, end) {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  try {
    const s = new Date(start);
    const eD = new Date(end);
    const sameMonth = s.getUTCFullYear() === eD.getUTCFullYear() && s.getUTCMonth() === eD.getUTCMonth();
    if (sameMonth) {
      return `${s.getUTCDate()}–${formatDate(end)}`;
    }
    return `${formatDate(start)} – ${formatDate(end)}`;
  } catch {
    return formatDate(start);
  }
}

function stars(rating) {
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < 1) return "";
  const n = Math.min(r, 5);
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// A DMS coordinate string ("37° 55′ 15.52″ N …") is not a place name worth
// showing — geo check-ins/photos store one as `location.name`.
function isCoordinateName(name) {
  return /\d\s*°/.test(String(name || ""));
}

// "Back to the timeline" link at the top of every post page (both languages
// emitted; CSS shows one per `:root[data-lang]`).
const BACK_LINK = `<a class="back" href="${BASE_URL}/"><span class="i18n-en">&larr; All activity</span><span class="i18n-es">&larr; Toda la actividad</span></a>`;

// Fixed navbar shared with www.rauljimenez.info. Rendered outside `.wrap`.
// Layout mirrors the Docusaurus navbar: brand + links on the left, the
// language + light/dark controls on the right. Both language variants of
// the links are emitted; CSS shows one per `:root[data-lang]`.
function navLinks(lang) {
  return NAV_LINKS.map((l) => {
    const v = lang === "es" ? l.es : l;
    return `<a class="site-nav__link"${l.current ? ' aria-current="page"' : ""} href="${escapeHtml(v.href)}">${escapeHtml(v.label)}</a>`;
  }).join("\n");
}
function siteNav() {
  return `<nav class="site-nav">
<a class="site-nav__brand" href="${MAIN_SITE}"><img src="${LOGO_URL}" alt="Raúl Jiménez Ortega"></a>
<button class="site-nav__toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="site-nav-menu">
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>
</button>
<div class="site-nav__menu" id="site-nav-menu">
<div class="site-nav__drawer-head">
<span class="i18n-en">Menu</span><span class="i18n-es">Menú</span>
<button class="site-nav__close" type="button" aria-label="Close menu">
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.4l-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.29z"/></svg>
</button>
</div>
<div class="site-nav__links i18n-en">
${navLinks("en")}
</div>
<div class="site-nav__links i18n-es">
${navLinks("es")}
</div>
<div class="site-nav__tools">
<button class="site-nav__lang" type="button" aria-label="Change language — cambiar idioma" title="English · Español">
<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a7.82 7.82 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4H4.26zm.81 2h2.95c.32 1.25.78 2.45 1.38 3.56A8.03 8.03 0 0 1 5.07 16zm2.95-8H5.07a8.03 8.03 0 0 1 4.33-3.56C8.8 5.55 8.34 6.75 8.02 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A13.9 13.9 0 0 1 12 19.96zM14.34 14H9.66a14.9 14.9 0 0 1 0-4h4.68a14.9 14.9 0 0 1 0 4zm.26 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38a7.82 7.82 0 0 1 0 4h-3.38z"/></svg>
<span class="i18n-en">ES</span><span class="i18n-es">EN</span>
</button>
<button class="site-nav__theme" type="button" aria-label="Switch between dark and light mode" title="Switch between dark and light mode">
<svg class="icon-sun" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm0 17a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zM4.22 4.22a1 1 0 0 1 1.42 0l1.06 1.06a1 1 0 0 1-1.42 1.42L4.22 5.64a1 1 0 0 1 0-1.42zm12.02 12.02a1 1 0 0 1 1.42 0l1.06 1.06a1 1 0 0 1-1.42 1.42l-1.06-1.06a1 1 0 0 1 0-1.42zM2 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1zm17 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zM4.22 19.78a1 1 0 0 1 0-1.42l1.06-1.06a1 1 0 0 1 1.42 1.42l-1.06 1.06a1 1 0 0 1-1.42 0zM16.24 7.76a1 1 0 0 1 0-1.42l1.06-1.06a1 1 0 1 1 1.42 1.42l-1.06 1.06a1 1 0 0 1-1.42 0z"/></svg>
<svg class="icon-moon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9.37 5.51A7.35 7.35 0 0 0 9.1 7.5c0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27A7.014 7.014 0 0 1 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49z"/></svg>
</button>
</div>
</div>
<div class="site-nav__backdrop" hidden></div>
</nav>`;
}

// Runs before first paint (inline, in <head>) so there's no flash of the
// wrong theme or chrome language.
//   theme: an explicit choice from localStorage, else the OS preference.
//   lang:  this only switches the site's *chrome* (nav, footer, headings)
//          via [data-lang] — NOT `<html lang>`, which is set server-side to
//          the language of the post/page content and must stay put so the
//          browser's own "translate this page" offer is correct.
//          ?lang=es|en (remembered), else localStorage, else the browser's
//          languages. No JS → English chrome (the static default).
const HEAD_INIT_SCRIPT = `<script>
(function(){var d=document.documentElement;
function mq(q){return window.matchMedia&&matchMedia(q).matches}
var t=null;try{t=localStorage.getItem("theme")}catch(e){}
d.dataset.theme=t==="dark"||t==="light"?t:(mq("(prefers-color-scheme: dark)")?"dark":"light");
try{matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(e){try{if(!localStorage.getItem("theme"))d.dataset.theme=e.matches?"dark":"light"}catch(_){}})}catch(e){}
function pickLang(){
try{var q=new URLSearchParams(location.search).get("lang");if(q==="es"||q==="en"){localStorage.setItem("lang",q);return q}}catch(e){}
try{var s=localStorage.getItem("lang");if(s==="es"||s==="en")return s}catch(e){}
var ls=navigator.languages||[navigator.language||"en"];
for(var i=0;i<ls.length;i++){if(/^es/i.test(ls[i]))return "es"}
return "en"}
var lang=pickLang();d.dataset.lang=lang;
try{var fl=localStorage.getItem("feedLang");if(fl==="en"||fl==="es")d.dataset.feedLang=fl}catch(e){}
addEventListener("DOMContentLoaded",function(){
var ff=document.querySelector(".feed-filter");
if(ff){var fbtns=ff.querySelectorAll(".feed-filter__btn");
function syncFF(){var c=d.dataset.feedLang||"";[].forEach.call(fbtns,function(b){b.setAttribute("aria-pressed",(b.dataset.feedLang||"")===c?"true":"false")})}
syncFF();
[].forEach.call(fbtns,function(b){b.addEventListener("click",function(){var v=b.dataset.feedLang||"";if(v)d.dataset.feedLang=v;else delete d.dataset.feedLang;try{v?localStorage.setItem("feedLang",v):localStorage.removeItem("feedLang")}catch(e){}syncFF()})});}
var tb=document.querySelector(".site-nav__theme");
if(tb)tb.addEventListener("click",function(){var n=d.dataset.theme==="dark"?"light":"dark";d.dataset.theme=n;try{localStorage.setItem("theme",n)}catch(e){}});
var lb=document.querySelector(".site-nav__lang");
if(lb)lb.addEventListener("click",function(){var n=d.dataset.lang==="es"?"en":"es";d.dataset.lang=n;try{localStorage.setItem("lang",n)}catch(e){}if(location.hash)try{dispatchEvent(new Event("hashchange"))}catch(e){}});
var nav=document.querySelector(".site-nav");
if(nav){var tg=nav.querySelector(".site-nav__toggle"),cl=nav.querySelector(".site-nav__close"),bd=nav.querySelector(".site-nav__backdrop");
function setMenu(o){nav.classList.toggle("is-open",o);document.body.classList.toggle("nav-open",o);if(bd)bd.hidden=!o;if(tg)tg.setAttribute("aria-expanded",o?"true":"false");}
if(tg)tg.addEventListener("click",function(){setMenu(!nav.classList.contains("is-open"))});
if(cl)cl.addEventListener("click",function(){setMenu(false)});
if(bd)bd.addEventListener("click",function(){setMenu(false)});
document.addEventListener("keydown",function(e){if(e.key==="Escape")setMenu(false)});
[].forEach.call(nav.querySelectorAll(".site-nav__link"),function(a){a.addEventListener("click",function(){setMenu(false)})});}
});})();
</script>`;

// Feed autodiscovery. The activity Atom feed plus both languages of the
// Docusaurus blog's feeds (so a reader on any page can find them). All are
// emitted for discoverability; the page's content language just orders its
// matching blog feeds first, so that's the "primary" one a reader offers.
function feedLinks(lang) {
  const activity =
    `<link rel="alternate" type="application/atom+xml" title="Raúl Jiménez — Activity" href="/feed.xml">`;
  const blog = {
    en: [
      `<link rel="alternate" type="application/atom+xml" hreflang="en" title="Raúl Jiménez — Blog (English)" href="https://www.rauljimenez.info/blog/atom.xml">`,
      `<link rel="alternate" type="application/rss+xml" hreflang="en" title="Raúl Jiménez — Blog (English, RSS)" href="https://www.rauljimenez.info/blog/rss.xml">`,
    ],
    es: [
      `<link rel="alternate" type="application/atom+xml" hreflang="es" title="Raúl Jiménez — Blog (Español)" href="https://www.rauljimenez.info/es/blog/atom.xml">`,
      `<link rel="alternate" type="application/rss+xml" hreflang="es" title="Raúl Jiménez — Blog (Español, RSS)" href="https://www.rauljimenez.info/es/blog/rss.xml">`,
    ],
  };
  const order = lang === "es" ? ["es", "en"] : ["en", "es"];
  return [activity, ...order.flatMap((l) => blog[l])].join("\n");
}

// `og` (optional): { url, description, image, type } for a post page.
// `image` is a screenshot generated by scripts/screenshot.mjs; the same
// file is attached as native media when the post is syndicated.
// `repCard` (default true): emit the hidden representative h-card. The
// index page passes false — it has no h-entry, so a top-level h-card there
// makes XRay (what webmention.io uses to verify) treat the whole page as a
// person card and stop looking for the target link in the page body, which
// breaks Webmentions *sent from* the index. Post pages have an h-entry that
// outranks the h-card, so it's safe (and useful) there.
// `webmentions` (defaults to the same value as `repCard`): render the
// "Responses from around the web" section + load /webmentions.js. Same split
// as repCard — individual post pages get it, the index/about pages don't.
function page({ title, body, og, repCard = true, webmentions = repCard, lang = SITE_DEFAULT_LANG }) {
  const o = og || {};
  const branded = fullTitle(title);
  const url = o.url || `${BASE_URL}/`;
  const type = o.type || "website";
  const description = o.description || SITE_DESCRIPTION;
  const image = o.image || SOCIAL_CARD;
  const imageAlt = o.imageAlt || (o.image ? branded : SOCIAL_CARD_ALT);
  // Only the site card's dimensions are known and fixed; per-post
  // screenshots are cropped to the post so their size varies.
  const cardDims = o.image
    ? ""
    : `
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`;

  const socialMeta = `
<meta name="description" content="${escapeHtml(description)}">
<meta name="author" content="${escapeHtml(AUTHOR_NAME)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:site_name" content="${escapeHtml(AUTHOR_NAME)}">
<meta property="og:locale" content="${OG_LOCALE[lang] || OG_LOCALE.en}">
<meta property="og:type" content="${escapeHtml(type)}">
<meta property="og:title" content="${escapeHtml(branded)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">${cardDims}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(branded)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">${
    type === "article" && o.published
      ? `
<meta property="article:published_time" content="${escapeHtml(o.published)}">
<meta property="article:author" content="${escapeHtml(AUTHOR_URL)}">`
      : ""
  }`;

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(branded)}</title>${socialMeta}
${HEAD_INIT_SCRIPT}
<link rel="icon" href="/favicon.ico">
<link rel="webmention" href="${WEBMENTION_ENDPOINT}">
<link rel="stylesheet" href="/style.css">
${feedLinks(lang)}
</head>
<body>
${siteNav()}
<div class="wrap">
${repCard ? repHCard() : ""}
${body}
${webmentions ? webmentionsSection(url) : ""}
<footer class="site">
<a class="i18n-en" href="${MAIN_SITE}">www.rauljimenez.info</a><a class="i18n-es" href="${MAIN_SITE_ES}">www.rauljimenez.info</a>
<a href="${BASE_URL}/about/"><span class="i18n-en">About this feed</span><span class="i18n-es">Sobre este feed</span></a>
<a href="/feed.xml">RSS</a>
<a href="${SOURCE_REPO}"><span class="i18n-en">Source on GitHub</span><span class="i18n-es">Código en GitHub</span></a>
</footer>
</div>
<script src="/timeline.js" defer></script>
<script src="/webmentions.js" defer></script>
</body>
</html>
`;
}

// The container that /webmentions.js fills in at page load with the likes,
// reposts, replies and mentions webmention.io has collected for this URL
// (including the ones Bridgy back-feeds from the Mastodon/Bluesky copies).
// Starts `hidden`; the script reveals it only when there's something to show,
// so a post with no responses renders nothing. Progressive enhancement —
// same deal as timeline.js. The `<link rel="canonical">` in the head is the
// target the script queries by — except under PREVIEW_BASE (`npm run dev`),
// where the canonical would point at localhost and match nothing, so we pin
// the real production URL with `data-wm-targets` to preview live responses.
function webmentionsSection(pageUrl) {
  const canonical = toCanonical(pageUrl);
  const previewTarget =
    canonical !== pageUrl ? ` data-wm-targets="${escapeHtml(canonical)}"` : "";
  return `<section class="webmentions" id="webmentions" hidden aria-labelledby="webmentions-title" data-wm-api="https://webmention.io/api/mentions.jf2"${previewTarget}>
<h2 class="webmentions__title" id="webmentions-title"><span class="i18n-en">Responses from around the web</span><span class="i18n-es">Respuestas de la web</span></h2>
<div class="webmentions__facepile" id="webmentions-facepile" hidden></div>
<ol class="webmentions__list" id="webmentions-list"></ol>
</section>`;
}

// The date at the top of a post *is* the permalink (standard h-entry
// pattern) — it carries `u-url` + `dt-published`, so there's no separate
// visible "Permalink" line further down (you're already on the page).
function renderMetaRow(type, published, url) {
  const date = published
    ? `<time class="dt-published" datetime="${escapeHtml(published)}">${escapeHtml(formatDateTime(published))}</time>`
    : "";
  const dateLink =
    date && url
      ? `<a class="u-url permalink" href="${escapeHtml(url)}">${date}</a>`
      : date || (url ? `<a class="u-url" href="${escapeHtml(url)}" hidden></a>` : "");
  return `<div class="meta">
<span class="badge ${type}">${escapeHtml(TYPE_LABEL[type])}</span>
${dateLink}
</div>`;
}

// The footer row under a post: only the "translate" link when it applies,
// plus the hidden nested author h-card (kept for Webmention consumers that
// read the mention's author from mf2 — it's the site owner on every post,
// so there's nothing to gain from showing it).
function renderPermalink(url, properties, lang) {
  const translate = translateLink(url, lang);
  const footer = translate
    ? `<p class="post-footer">${translate}</p>`
    : "";
  return `${footer}${authorHCard()}${respondSection(url, properties, lang)}`;
}

// The "Respond" block under each post: the IndieWeb reply affordance.
// It folds in what used to be a separate "Also posted on …" line — the
// per-network links here still carry `class="u-syndication"`, so the
// canonical post stays machine-linked to its syndicated copies (POSSE best
// practice, and how Bridgy-style backfeed matches them).
//
// `syndication` in the front matter is an array of status URLs written back
// by @indiekit/endpoint-syndicate.
const SYNDICATION_NETWORKS = {
  "mastodon.social": {
    label: "Mastodon",
    cls: "is-mastodon",
    // simple-icons: Mastodon
    icon: '<path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.66 9.143c.073 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.222-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.667-1.67 1.976v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.504 2.962 1.51l.638 1.06.638-1.06c.66-1.006 1.65-1.51 2.96-1.51 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/>',
  },
  "bsky.app": {
    label: "Bluesky",
    cls: "is-bluesky",
    // simple-icons: Bluesky
    icon: '<path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.829.624-5.79.624-6.479 0-.688-.139-1.86-.902-2.203-.659-.299-1.664-.621-4.3 1.24C16.046 4.747 13.087 8.686 12 10.8z"/>',
  },
};
function syndicationNetwork(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    return (
      SYNDICATION_NETWORKS[host] || {
        label: host,
        cls: "",
        icon: '<path d="M12 0a12 12 0 100 24 12 12 0 000-24zm0 4.8a2.4 2.4 0 110 4.8 2.4 2.4 0 010-4.8zM12 19.2a5.76 5.76 0 01-4.8-2.573c.024-1.59 3.2-2.46 4.8-2.46 1.591 0 4.776.87 4.8 2.46A5.76 5.76 0 0112 19.2z"/>',
      }
    );
  } catch {
    return null;
  }
}

// Bilingual <span> pair (CSS shows one via [data-lang]).
function i18nSpan(en, es) {
  return `<span class="i18n-en">${escapeHtml(en)}</span><span class="i18n-es">${escapeHtml(es)}</span>`;
}

function respondSection(url, properties, lang) {
  const target = toCanonical(url);
  const synUrls = []
    .concat(properties?.syndication || [])
    .filter((u) => typeof u === "string" && u);

  const networks = synUrls
    .map((u) => ({ url: u, net: syndicationNetwork(u) }))
    .filter((x) => x.net);

  // Block 1 — the syndicated copies. The links carry `u-syndication`, so
  // they double as the POSSE machine-links (no separate "Also posted on").
  const social = networks.length
    ? `
<div class="respond__block">
<p class="respond__label">${i18nSpan("Also posted on:", "También publicado en:")}</p>
<div class="respond__networks">
${networks
  .map(
    ({ url: u, net }) =>
      `<a class="respond__net u-syndication ${net.cls}" href="${escapeHtml(u)}" rel="nofollow"><svg class="respond__logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="currentColor">${net.icon}</svg><span>${escapeHtml(net.label)}</span><svg class="respond__ext" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="currentColor"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h5v2H7v10h10v-3h2v5H5V5z"/></svg></a>`,
  )
  .join("\n")}
</div>
<p class="respond__hint"><span class="i18n-en">Open it there to reply, like or boost — <a href="/about/#reacting">it flows back here</a>.</span><span class="i18n-es">Ábrelo ahí para responder, dar me gusta o compartir — <a href="/about/#reacting">vuelve aquí por Webmention</a>.</span></p>
</div>`
    : `
<div class="respond__block">
<p class="respond__hint respond__hint--none"><span class="i18n-en">This post wasn’t cross-posted to social media — <a href="/about/#why-not-shared">why?</a></span><span class="i18n-es">Este post no se ha compartido en redes sociales — <a href="/about/#why-not-shared">¿por qué?</a></span></p>
</div>`;

  // Collapsed behind a native <details> so it takes no space until opened
  // (and still works with JS disabled — webmentions.js only adds the
  // scroll-into-view nicety on small screens).
  return `
<details class="respond-toggle">
<summary class="respond-toggle__btn">
<svg class="respond-toggle__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
<span class="i18n-en">Respond</span><span class="i18n-es">Responder</span>
<svg class="respond-toggle__chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
</summary>
<section class="respond" aria-label="Respond to this post">
${social}
<div class="respond__block">
<p class="respond__label">${i18nSpan("Respond from your own site:", "Responde desde tu propia web:")}</p>
<form class="respond__form" method="post" action="${WEBMENTION_ENDPOINT}" target="respond-sink">
<input type="hidden" name="target" value="${escapeHtml(target)}">
<div class="respond__field">
<input class="respond__url" id="respond-source" type="url" name="source" required placeholder="https://tu-web.example/…" autocomplete="url" spellcheck="false" inputmode="url" aria-label="URL of your response">
<button class="respond__submit" type="submit">${i18nSpan("Send webmention", "Enviar webmention")}</button>
</div>
</form>
<p class="respond__hint">${i18nSpan(
    "Publish a reply on your site, then paste its URL — it’ll appear above once verified.",
    "Publica una respuesta en tu web y pega aquí su URL — aparecerá arriba cuando se verifique.",
  )}</p>
<p class="respond__thanks" role="status" hidden>${i18nSpan(
    "Thanks! Your response will show up here once webmention.io verifies it.",
    "¡Gracias! Tu respuesta aparecerá aquí cuando webmention.io la verifique.",
  )}</p>
</div>
<iframe class="respond__sink" name="respond-sink" title="" aria-hidden="true" tabindex="-1"></iframe>
</section>
</details>`;
}

function ogDescription(text, fallback) {
  const plain = markdownToPlain(text);
  if (!plain) return fallback;
  return plain.length > 200 ? `${plain.slice(0, 199).trimEnd()}…` : plain;
}

// screenshot.mjs writes screenshot.png alongside each post's index.html.
function screenshotUrl(url) {
  return `${url}/screenshot.png`;
}

// h-event: name/start/end/location live in the front matter, not the body.
function renderEventHtml({ url, properties, content }) {
  const published = properties.published || "";
  const name = properties.name || "Event";
  const start = properties.start || "";
  const end = properties.end || "";
  const location = locationText(properties.location);
  const eventUrl = properties.url;
  const lang = postLang(properties, content);

  const body = `
${BACK_LINK}
<article class="h-event" lang="${lang}">
${renderMetaRow("event", published, eventUrl ? "" : url)}
<h1 class="p-name">${escapeHtml(name)}</h1>
<p class="event-when">
${start ? `<time class="dt-start" datetime="${escapeHtml(start)}">${escapeHtml(formatDate(start))}</time>` : ""}
${end ? ` – <time class="dt-end" datetime="${escapeHtml(end)}">${escapeHtml(formatDate(end))}</time>` : ""}
</p>
${location ? `<p class="event-where">📍 <span class="p-location">${escapeHtml(location)}</span></p>` : ""}
${eventUrl ? `<p class="target"><a class="u-url" href="${escapeHtml(eventUrl)}">${escapeHtml(eventUrl)}</a></p>` : ""}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties, lang)}
</article>`;

  const when = [formatDate(start), end && `– ${formatDate(end)}`].filter(Boolean).join(" ");
  return page({
    title: name,
    lang,
    body,
    og: {
      url,
      type: "event",
      image: screenshotUrl(url),
      description: ogDescription(content, [when, location].filter(Boolean).join(" · ")),
    },
  });
}

// Photos: `properties.photo` is an array of { url, alt } (or bare URL
// strings). Body text, if any, is the caption.
function photoList(photo) {
  return [].concat(photo || []).map((p) =>
    typeof p === "string"
      ? { url: p }
      : (p.properties
        ? { url: p.properties.url?.[0] ?? p.properties.url, alt: p.properties.alt?.[0] ?? p.properties.alt }
        : p),
  ).filter((p) => p && p.url);
}
function photoImgs(photos) {
  return photos.map((p) => `<img class="u-photo" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.alt || "")}" loading="lazy">`).join("\n");
}

function renderPhotoHtml({ url, properties, content }) {
  const published = properties.published || "";
  const photos = photoList(properties.photo);
  const lang = postLang(properties, content);

  const body = `
${BACK_LINK}
<article class="h-entry" lang="${lang}">
${renderMetaRow("photo", published, url)}
${properties.name
  ? `<h1 class="p-name">${escapeHtml(properties.name)}</h1>`
  : `<h1 class="visually-hidden">${escapeHtml(`Photo — ${formatDate(published)}`)}</h1>`}
${photoImgs(photos)}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties, lang)}
</article>`;

  return page({
    title: properties.name || `Photo — ${formatDate(published)}`,
    lang,
    body,
    og: { url, type: "article", published, image: photos[0]?.url || screenshotUrl(url), description: ogDescription(content, "Photo · posts.rauljimenez.info") },
  });
}

// Articles: title in the front matter, long-form body.
function renderArticleHtml({ url, properties, content }) {
  const published = properties.published || "";
  const name = properties.name || "Article";
  const lang = postLang(properties, content);
  const body = `
${BACK_LINK}
<article class="h-entry" lang="${lang}">
${renderMetaRow("article", published, url)}
<h1 class="p-name">${escapeHtml(name)}</h1>
<div class="content e-content">${renderMarkdown(content)}</div>
${renderPermalink(url, properties, lang)}
</article>`;
  return page({
    title: name,
    lang,
    body,
    og: { url, type: "article", published, image: screenshotUrl(url), description: ogDescription(properties.summary || content, name) },
  });
}

// h-entry with a nested h-card for the venue (`checkin`). No Webmention is
// sent for these (a check-in isn't a response to another page).
function renderCheckinHtml({ url, properties, content }) {
  const published = properties.published || "";
  const c = cite(properties.checkin);
  const name = c.name || "a place";
  const venueUrl = citeUrl(properties.checkin);
  const lat = c.latitude;
  const lon = c.longitude;
  const mapHref = venueUrl
    || (lat && lon ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=17/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}` : "");

  const venue = `<span class="p-location h-card">${
    mapHref
      ? `<a class="p-name u-url" href="${escapeHtml(mapHref)}">${escapeHtml(name)}</a>`
      : `<span class="p-name">${escapeHtml(name)}</span>`
  }${lat && lon ? `<data class="p-latitude" value="${escapeHtml(lat)}"></data><data class="p-longitude" value="${escapeHtml(lon)}"></data>` : ""}</span>`;

  const photos = photoList(properties.photo);
  const lang = postLang(properties, content);
  const body = `
${BACK_LINK}
<article class="h-entry" lang="${lang}">
<h1 class="visually-hidden">${escapeHtml(`Check-in at ${name}`)}</h1>
${renderMetaRow("checkin", published, url)}
<p class="target">📍 Checked in at ${venue}</p>
${photoImgs(photos)}
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties, lang)}
</article>`;

  return page({
    title: `Check-in at ${name}`,
    lang,
    body,
    og: { url, type: "article", published, image: screenshotUrl(url), description: ogDescription(content, `Checked in at ${name}`) },
  });
}

// h-review: the reviewed thing is `item` (rendered as p-item h-item), the
// score is `rating` on a 1–5 scale, the body is the p-description.
function renderReviewHtml({ url, properties, content }) {
  const published = properties.published || "";
  const it = cite(properties.item);
  const itemName = it.name || "something";
  const itemUrl = citeUrl(properties.item);
  const rating = Number(properties.rating);
  const hasRating = Number.isFinite(rating);
  const headline = properties.name || "";
  const lang = postLang(properties, content);

  const item = `<span class="p-item h-item">${
    itemUrl
      ? `<a class="p-name u-url" href="${escapeHtml(itemUrl)}">${escapeHtml(itemName)}</a>`
      : `<span class="p-name">${escapeHtml(itemName)}</span>`
  }${it.author ? ` by <span class="p-author">${escapeHtml(it.author)}</span>` : ""}</span>`;

  const body = `
${BACK_LINK}
<article class="h-review" lang="${lang}">
${renderMetaRow("review", published, url)}
<p class="target">📝 Review of ${item}</p>
${headline
  ? `<h1 class="p-name">${escapeHtml(headline)}</h1>`
  : `<h1 class="visually-hidden">${escapeHtml(`Review of ${itemName}`)}</h1>`}
${hasRating ? `<p class="review-rating">Rating: <data class="p-rating" value="${rating}">${rating}</data><data class="p-best" value="5"></data><data class="p-worst" value="1"></data> / 5</p>` : ""}
<div class="content e-content p-description">${renderMarkdown(content)}</div>
${renderPermalink(url, properties, lang)}
</article>`;

  return page({
    title: headline || `Review of ${itemName}`,
    lang,
    body,
    og: { url, type: "article", published, image: screenshotUrl(url), description: ogDescription(content, `Review of ${itemName}${hasRating ? ` — ${rating}/5` : ""}`) },
  });
}

// read / watch / listen — an h-entry citing the consumed work (h-cite).
const CONSUMED = {
  read: { prop: "read-of", uClass: "u-read-of", icon: "📚", verb: "Read", statusProp: "read-status" },
  watch: { prop: "watch-of", uClass: "u-watch-of", icon: "🎬", verb: "Watched" },
  listen: { prop: "listen-of", uClass: "u-listen-of", icon: "🎧", verb: "Listened to" },
};
const READ_STATUS_LABEL = {
  "to-read": "Want to read", "want-to-read": "Want to read",
  reading: "Reading", finished: "Finished reading", read: "Finished reading",
};
function renderConsumedHtml(type, { url, properties, content }) {
  const spec = CONSUMED[type];
  const published = properties.published || "";
  const w = cite(properties[spec.prop]);
  const workName = w.name || "something";
  const workUrl = citeUrl(properties[spec.prop]);
  const rating = Number(properties.rating);
  const hasRating = Number.isFinite(rating);
  const status = spec.statusProp ? String(properties[spec.statusProp] || "").toLowerCase() : "";
  const verb = status ? (READ_STATUS_LABEL[status] || spec.verb) : spec.verb;
  const lang = postLang(properties, content);

  const work = `<span class="${spec.uClass} h-cite">${
    workUrl
      ? `<a class="p-name u-url" href="${escapeHtml(workUrl)}">${escapeHtml(workName)}</a>`
      : `<span class="p-name">${escapeHtml(workName)}</span>`
  }${w.author ? ` by <span class="p-author">${escapeHtml(w.author)}</span>` : ""}</span>`;

  const body = `
${BACK_LINK}
<article class="h-entry" lang="${lang}">
<h1 class="visually-hidden">${escapeHtml(`${verb} ${workName}`)}</h1>
${renderMetaRow(type, published, url)}
${status ? `<data class="p-read-status" value="${escapeHtml(status)}"></data>` : ""}
<p class="target">${spec.icon} ${escapeHtml(verb)} ${work}${hasRating ? ` — <data class="p-rating" value="${rating}">${rating}/5</data>` : ""}</p>
${content ? `<div class="content e-content">${renderMarkdown(content)}</div>` : ""}
${renderPermalink(url, properties, lang)}
</article>`;

  return page({
    title: `${verb} ${workName}`,
    lang,
    body,
    og: { url, type: "article", published, image: screenshotUrl(url), description: ogDescription(content, `${verb} ${workName}`) },
  });
}

function renderPostHtml({ type, url, properties, content }) {
  // A check-in that also carries a photo is stored as `post-type: photo`
  // (Indiekit's discovery can't be reordered) — treat any post with a
  // `checkin` property as a check-in.
  if (properties.checkin) return renderCheckinHtml({ url, properties, content });
  if (type === "event") return renderEventHtml({ url, properties, content });
  if (type === "review") return renderReviewHtml({ url, properties, content });
  if (type === "read" || type === "watch" || type === "listen") {
    return renderConsumedHtml(type, { url, properties, content });
  }
  if (type === "article") return renderArticleHtml({ url, properties, content });
  if (type === "photo") return renderPhotoHtml({ url, properties, content });

  const target = targetOf(properties);
  const published = properties.published || "";
  const rsvp = type === "rsvp" ? properties.rsvp : "";
  const lang = postLang(properties, content);

  // These types carry no visible <h1> (the meta row + target line say it
  // all), so give the page an off-screen one for the document outline.
  const heading = properties.name
    || (TYPE_VERB[type] && target ? `${TYPE_VERB[type]} ${hostOf(target) || target}` : `${TYPE_LABEL[type]} — ${formatDate(published)}`);

  const body = `
${BACK_LINK}
<article class="h-entry" lang="${lang}">
<h1 class="visually-hidden">${escapeHtml(heading)}</h1>
${renderMetaRow(type, published, url)}
${rsvp ? `<p class="rsvp-answer">RSVP: <data class="p-rsvp" value="${escapeHtml(rsvp)}">${escapeHtml(rsvp)}</data></p>` : ""}
${target ? `<p class="target">${escapeHtml(TYPE_VERB[type] || "")} <a class="${targetClassOf(type)}" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>` : ""}
<div class="content e-content">${renderMarkdown(content)}</div>
${renderPermalink(url, properties, lang)}
</article>`;

  const fallbackDescription =
    (TYPE_VERB[type] && target ? `${TYPE_VERB[type]} ${target}` : `${TYPE_LABEL[type]} · posts.rauljimenez.info`);
  return page({
    title: properties.name || `${TYPE_LABEL[type]} — ${formatDate(published)}`,
    lang,
    body,
    og: {
      url,
      type: "article",
      published,
      image: screenshotUrl(url),
      description: ogDescription(content, fallbackDescription),
    },
  });
}

// Everything the timeline needs to render one card so the post reads at a
// glance: an icon + action verb, the thing it refers to (linked), a rating,
// a body excerpt and any image. `action` is left empty for types whose
// badge already says it all (note/photo/article/event).
const RSVP_ACTION = {
  yes: ["✅", "Going to"], no: ["❌", "Not going to"],
  maybe: ["❔", "Maybe going to"], interested: ["⭐", "Interested in"],
};
function feedEntry(type, properties, content, _url) {
  const e = {
    type, badge: TYPE_LABEL[type], icon: "", action: "", subject: "",
    subjectUrl: "", author: "", rating: null, headline: "", excerpt: "",
    images: [], contextHost: "", whenLine: "", lang: postLang(properties, content),
  };
  const body = excerptOf(content);

  const linkTarget = (t) => {
    const host = hostOf(t);
    e.subject = properties.name || host || (typeof t === "string" ? t : "");
    e.subjectUrl = typeof t === "string" ? t : "";
    // Only worth a separate context line when we have a real title above it.
    if (properties.name && host) e.contextHost = host;
    e.excerpt = body;
  };
  const consumed = () => {
    const spec = CONSUMED[type];
    const w = cite(properties[spec.prop]);
    const status = spec.statusProp ? String(properties[spec.statusProp] || "").toLowerCase() : "";
    e.icon = spec.icon;
    e.action = status ? (READ_STATUS_LABEL[status] || spec.verb) : spec.verb;
    e.subject = w.name || "something";
    e.subjectUrl = citeUrl(properties[spec.prop]) || "";
    e.author = w.author || "";
    e.contextHost = hostOf(e.subjectUrl);
    const r = Number(properties.rating);
    e.rating = Number.isFinite(r) ? r : null;
    e.excerpt = body;
    const img = firstContentImage(content);
    if (img) e.images = [img];
  };

  switch (type) {
    case "bookmark":
      e.icon = "🔖"; e.action = "Bookmarked"; linkTarget(properties["bookmark-of"]);
      break;
    case "like":
      e.icon = "⭐"; e.action = "Liked"; linkTarget(properties["like-of"]);
      break;
    case "reply":
      e.icon = "💬"; e.action = "Replied to"; linkTarget(properties["in-reply-to"]);
      break;
    case "repost":
      e.icon = "🔁"; e.action = "Reposted"; linkTarget(properties["repost-of"]);
      break;
    case "rsvp": {
      const [icon, verb] = RSVP_ACTION[String(properties.rsvp || "").toLowerCase()] || ["🗓️", "RSVP to"];
      e.icon = icon; e.action = verb; linkTarget(properties["in-reply-to"]);
      break;
    }
    case "event": {
      const speaking = [].concat(properties.category || []).includes("speaking");
      e.headline = `${speaking ? "🎤 " : ""}${properties.name || "Event"}`;
      const locName = locationText(properties.location);
      const locCity = properties.location?.locality || properties.location?.properties?.locality;
      const loc = [locName, locCity && locName !== locCity ? locCity : ""].filter(Boolean).join(", ");
      e.whenLine = [formatDateRange(properties.start, properties.end), loc].filter(Boolean).join(" · ");
      e.excerpt = body;
      break;
    }
    case "checkin": {
      const c = cite(properties.checkin);
      e.icon = "📍"; e.action = "Checked in at";
      e.subject = c.name || "a place";
      e.subjectUrl = citeUrl(properties.checkin) || "";
      e.images = photoList(properties.photo);
      e.excerpt = body;
      break;
    }
    case "review": {
      const it = cite(properties.item);
      e.icon = "📝"; e.action = "Reviewed";
      e.subject = it.name || "something";
      e.subjectUrl = citeUrl(properties.item) || "";
      e.author = it.author || "";
      e.contextHost = hostOf(e.subjectUrl);
      const r = Number(properties.rating);
      e.rating = Number.isFinite(r) ? r : null;
      e.headline = properties.name || "";
      e.excerpt = body;
      const img = firstContentImage(content);
      if (img) e.images = [img];
      break;
    }
    case "read":
    case "watch":
    case "listen":
      consumed();
      break;
    case "photo": {
      e.headline = properties.name || "";
      e.images = photoList(properties.photo);
      const place = locationText(properties.location);
      if (place && !isCoordinateName(place)) e.whenLine = `📍 ${place}`;
      e.excerpt = body;
      break;
    }
    case "article":
      e.headline = properties.name || "Article";
      e.excerpt = excerptOf(properties.summary || content);
      { const img = firstContentImage(content); if (img) e.images = [img]; }
      break;
    default: // note
      e.headline = properties.name || "";
      e.excerpt = body;
      { const img = firstContentImage(content); if (img) e.images = [img]; }
  }
  return e;
}

function feedImages(images, max = 4) {
  const list = images.slice(0, max);
  if (!list.length) return "";
  const imgs = list
    .map((p) => `<img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.alt || "")}" loading="lazy">`)
    .join("");
  return `<div class="fc-media${list.length > 1 ? " fc-media--multi" : ""}">${imgs}</div>`;
}

function renderFeedCard(e, url, published) {
  const subject = e.subject
    ? (e.subjectUrl
      ? `<a class="fc-subject" href="${escapeHtml(e.subjectUrl)}">${escapeHtml(e.subject)}</a>`
      : `<span class="fc-subject">${escapeHtml(e.subject)}</span>`)
    : "";
  const action = e.action
    ? `<p class="fc-action"><span class="fc-icon">${e.icon}</span> ${escapeHtml(e.action)}${subject ? ` ${subject}` : ""}${e.author ? ` <span class="fc-by">by ${escapeHtml(e.author)}</span>` : ""}${e.rating ? ` <span class="fc-rating" title="${e.rating}/5">${stars(e.rating)}</span>` : ""}</p>`
    : "";
  const headline = e.headline ? `<p class="fc-headline">${escapeHtml(e.headline)}</p>` : "";
  const when = e.whenLine ? `<p class="fc-when">${escapeHtml(e.whenLine)}</p>` : "";
  const excerpt = e.excerpt ? `<p class="fc-excerpt">${escapeHtml(e.excerpt)}</p>` : "";
  const context = e.contextHost ? `<p class="fc-context">${escapeHtml(e.contextHost)}</p>` : "";

  const canonical = toCanonical(url);
  const canonAttr = canonical !== url ? ` data-canonical="${escapeHtml(canonical)}"` : "";
  return `<li class="fc fc--${e.type}" lang="${escapeHtml(e.lang || SITE_DEFAULT_LANG)}"${canonAttr}>
<a class="fc-perma" href="${escapeHtml(url)}" aria-label="Open this post"></a>
<div class="fc-head">
<span class="badge ${e.type}">${escapeHtml(e.badge)}</span>
<time datetime="${escapeHtml(published || "")}">${escapeHtml(feedTime(published))}</time>
</div>
${action}${headline}${when}${excerpt}${feedImages(e.images)}${context}
</li>`;
}

// Language filter for the timeline. Every `.fc` card carries `lang="en|es"`;
// picking a language sets `[data-feed-lang]` on <html> and CSS hides the
// non-matching cards (and now-empty day headings, via `:has()`). Default is
// "all" — an opt-in filter, never hides content by surprise. The choice is
// remembered in localStorage and applied pre-paint by HEAD_INIT_SCRIPT.
// Progressive enhancement: with no JS the buttons do nothing and every
// post shows.
function feedFilter() {
  const btn = (lang, en, es) =>
    `<button type="button" class="feed-filter__btn" data-feed-lang="${lang}"><span class="i18n-en">${en}</span><span class="i18n-es">${es}</span></button>`;
  return `<div class="feed-filter" role="group" aria-label="Filter posts by language">
<span class="feed-filter__label"><span class="i18n-en">Language</span><span class="i18n-es">Idioma</span></span>
${btn("", "All", "Todos")}
${btn("en", "English", "English")}
${btn("es", "Español", "Español")}
</div>`;
}

// Reverse-chronological cards for one page of the timeline, grouped under a
// per-calendar-day heading. `timeline.js` relies on this exact shape (a
// `.timeline` wrapper, `h2.feed-day` headings, sibling `ul.feed` lists) to
// splice pages together, deduping a heading repeated at a page seam.
function renderTimeline(items) {
  let html = "";
  let currentDay = null;
  for (const p of items) {
    const day = feedDay(p.published);
    if (day !== currentDay) {
      if (currentDay !== null) html += "</ul>\n";
      html += `<h2 class="feed-day">${escapeHtml(day)}</h2>\n<ul class="feed">\n`;
      currentDay = day;
    }
    html += `${renderFeedCard(p.entry, p.url, p.published)}\n`;
  }
  if (currentDay !== null) html += "</ul>";
  return `<div class="timeline">\n${html}\n</div>`;
}

// Bottom-of-page pager + the sentinel `timeline.js` observes. `next` is the
// path of the older page (or "" on the last page).
function pager(prev, next) {
  // Single-page timeline: no empty bordered bar, just the scroll sentinel.
  if (!prev && !next) return `<div id="timeline-end"></div>`;
  const links = [
    prev ? `<a class="pager__link" rel="prev" href="${escapeHtml(prev)}">← Newer</a>` : "<span></span>",
    next ? `<a class="pager__link" rel="next" href="${escapeHtml(next)}">Older →</a>` : "<span></span>",
  ].join("\n");
  return `<nav class="pager">\n${links}\n</nav>\n<div id="timeline-end"${next ? ` data-next="${escapeHtml(next)}"` : ""}></div>`;
}

function xmlEscape(string) {
  return String(string).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[c]);
}

// A short human title for a feed entry, reusing the timeline card model.
function feedEntryTitle(item) {
  const e = item.entry;
  if (e.headline) return e.headline;
  if (e.action) return [e.action, e.subject].filter(Boolean).join(" ");
  return `${TYPE_LABEL[item.type] || "Post"} — ${formatDate(item.published)}`;
}

// Atom 1.0 feed of the newest FEED_MAX posts. Built from the same sorted
// `index` main() already has — no extra passes over the content tree.
function buildFeed(index) {
  const items = index.slice(0, FEED_MAX);
  const updated = items[0]?.published || new Date().toISOString();

  const entries = items.map((item) => {
    const e = item.entry;
    const title = feedEntryTitle(item);
    const subject = e.subject
      ? (e.subjectUrl
        ? `<a href="${escapeHtml(e.subjectUrl)}">${escapeHtml(e.subject)}</a>`
        : escapeHtml(e.subject))
      : "";
    const actionLine = e.action
      ? `<p>${e.icon ? `${escapeHtml(e.icon)} ` : ""}${escapeHtml(e.action)}${subject ? ` ${subject}` : ""}${e.author ? ` by ${escapeHtml(e.author)}` : ""}${e.rating ? ` — ${escapeHtml(stars(e.rating))}` : ""}</p>`
      : "";
    const image = e.images?.[0]
      ? `<p><img src="${escapeHtml(e.images[0].url)}" alt="${escapeHtml(e.images[0].alt || "")}"></p>`
      : "";
    const bodyHtml = item.contentHtml || "";
    const html = `${actionLine}${image}${bodyHtml}`.trim()
      || `<p>${escapeHtml(feedEntryTitle(item))}</p>`;
    return `  <entry xml:lang="${xmlEscape(item.entry.lang || SITE_DEFAULT_LANG)}">
    <title>${xmlEscape(title)}</title>
    <link href="${xmlEscape(item.url)}"/>
    <id>${xmlEscape(item.url)}</id>
    <published>${xmlEscape(item.published || updated)}</published>
    <updated>${xmlEscape(item.published || updated)}</updated>
    <category term="${xmlEscape(item.type)}"/>
    <content type="html">${xmlEscape(html)}</content>
  </entry>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Raúl Jiménez — Activity</title>
  <subtitle>Notes, links, photos, events, reviews and things read, watched and listened to — self-hosted, not on a platform.</subtitle>
  <link href="${BASE_URL}/feed.xml" rel="self"/>
  <link href="${BASE_URL}/"/>
  <id>${BASE_URL}/</id>
  <updated>${xmlEscape(updated)}</updated>
  <author>
    <name>${xmlEscape(AUTHOR_NAME)}</name>
    <uri>${xmlEscape(AUTHOR_URL)}</uri>
  </author>
${entries}
</feed>
`;
}

const ABOUT_POST_ES =
  "https://www.rauljimenez.info/es/blog/first-steps-into-the-indieweb";

function renderAboutHtml() {
  const en = `<article class="content e-content prose">
<h1>About this feed</h1>

<p><strong>This is my activity feed.</strong> It's the kind of thing you'd
normally post on a social network — short notes, links I found worth keeping,
photos, events I'm going to, things I've read, watched or listened to — except
it doesn't live on a platform. It lives on my own domain, and every post is a
plain file in a public Git repository I control:
<a href="${SOURCE_REPO}">github.com/hhkaos/posts.rauljimenez.info</a>.</p>

<p>It's built following the <a href="https://indieweb.org/">IndieWeb</a>
approach: <em>your content, on your site, first</em>. If you're curious why I
bothered, the <a href="https://indieweb.org/why">reasons</a> and
<a href="https://indieweb.org/principles">principles</a> are worth a read, and I
wrote up how I put this together in
<a href="${ABOUT_POST}">First steps into the IndieWeb</a>.</p>

<h2>Not just the usual "post" types</h2>
<p>A social network gives you a status box and maybe a photo upload. Here the
"posts" are typed: notes, bookmarks, likes, replies, reposts, RSVPs, events,
check-ins, reviews, and separate types for things read, watched and listened
to. Some of these have no real equivalent on a mainstream network.</p>

<h2>What this makes possible</h2>
<p>Because every post is structured data in a repository I own — not locked
inside someone's app — I can build on top of it. For example, I'd like to put
every geotagged post (photos, check-ins, reviews…) on a map of the places I've
been. That's only possible because the data is mine and out in the open.</p>

<h2>Where else it shows up</h2>
<p>A lot of what's here is also cross-posted to my
<a href="https://mastodon.social/@hhkaos">Mastodon</a> and
<a href="https://bsky.app/profile/rauljimenez.info">Bluesky</a> accounts. When
it is, this copy is the canonical one and the social post links back to it —
the IndieWeb calls this <a href="https://indieweb.org/POSSE">POSSE</a> (Publish
on your Own Site, Syndicate Elsewhere). Either way the complete and permanent
record is the <a href="${SOURCE_REPO}">GitHub repo</a>.</p>

<h2 id="why-not-shared">Why some posts aren't on social media</h2>
<p>Plenty of what's here never reaches Mastodon or Bluesky, and that's on
purpose:</p>
<ul>
<li>It's something I want on the record and don't mind being public, but that
isn't timely, newsworthy or useful enough to drop into the feed of people who
follow me there — I'd rather not clutter their timeline with it.</li>
<li>Some of these post types (a review, an RSVP, a "watched", a check-in) have
no clean way to syndicate to a given platform anyway — the tools just aren't
there, and often it isn't worth the bother.</li>
<li>It's here for later: for someone who wants to get to know me a bit better,
for pulling up a recommendation I once made, or simply because I wanted to keep
it.</li>
</ul>

<h2 id="reacting">Reacting to a post</h2>
<p>Every post page has a <strong>Respond</strong> button. If the post was
cross-posted, it links to the copy on Mastodon or Bluesky — reply, like or
boost it there and it shows up back here. Two things worth knowing: unlike a
normal social app that's <em>not</em> instant (it can take a few minutes) and
it happens on that other site, not here. If you have your own website you can
also send a <a href="https://indieweb.org/Webmention">Webmention</a> straight
from the form.</p>

<h2 id="subscribe">How to subscribe</h2>
<p>This feed has an <a href="/feed.xml">Atom feed</a>. Paste
<code>posts.rauljimenez.info/feed.xml</code> — or just this site's address —
into any feed reader (NetNewsWire, Feedly, Reeder, Thunderbird, your browser…)
and new posts turn up there, no account or algorithm in between. Every page also
advertises it for auto-discovery, so most readers find it from the URL alone.
My <a href="https://www.rauljimenez.info/blog">blog</a> has its own feeds
(English and Spanish), linked the same way.</p>

<h2 id="languages">Languages</h2>
<p>I write some posts in English and some in Spanish, depending on who they're
for. I haven't found a good way to publish everything in both — hand-translating
every note isn't realistic — so for now each post carries a 🌐 button that opens
it in Google Translate, and you can filter the timeline to a single language.</p>

<h2>Why not just use social media</h2>
<p>Because the social platforms we know are not neutral tools. Their incentives
are not my incentives, they can disappear my content or my account, and the way
they're designed to hold attention has real costs. If that sounds abstract, the
documentary <a href="https://www.imdb.com/title/tt11464826/"><em>The Social
Dilemma</em></a> lays it out well. Owning this myself is a small way of opting
out.</p>

<h2>License</h2>
<p>All <strong>content</strong> published on this site — text, photos — is
licensed <a href="${LICENSE_URL}" rel="license"><strong>Creative Commons
Attribution 4.0 International (CC&nbsp;BY&nbsp;4.0)</strong></a>. You're free to
share and adapt it, including commercially, as long as you credit me
(name + a link back). The site's source code, in the repository above, is a
separate matter.</p>

<p style="margin-top:2rem"><a href="${BASE_URL}/">&larr; Back to the timeline</a>
· <a href="/feed.xml">RSS</a></p>
</article>`;

  const es = `<article class="content prose">
<h1>Sobre este feed</h1>

<p><strong>Este es mi feed de actividad.</strong> Es el tipo de cosas que
normalmente publicarías en una red social —notas breves, enlaces que me ha
parecido que merecía la pena guardar, fotos, eventos a los que voy, cosas que
he leído, visto o escuchado— salvo que no vive en una plataforma. Vive en mi
propio dominio, y cada publicación es un simple archivo en un repositorio Git
público que yo controlo:
<a href="${SOURCE_REPO}">github.com/hhkaos/posts.rauljimenez.info</a>.</p>

<p>Está construido siguiendo el enfoque <a href="https://indieweb.org/">IndieWeb</a>:
<em>tu contenido, en tu sitio, primero</em>. Si tienes curiosidad por saber por
qué me molesté, merece la pena leer las <a href="https://indieweb.org/why">razones</a>
y los <a href="https://indieweb.org/principles">principios</a>, y conté cómo lo
monté en <a href="${ABOUT_POST_ES}">Primeros pasos en la IndieWeb</a>.</p>

<h2>No solo los tipos de publicación de siempre</h2>
<p>Una red social te da una caja de estado y quizá una subida de foto. Aquí las
publicaciones están tipadas: notas, enlaces, me gusta, respuestas,
republicaciones, confirmaciones de asistencia (RSVP), eventos, check-ins,
reseñas, y tipos aparte para lo leído, lo visto y lo escuchado. Algunos no
tienen equivalente real en una red convencional.</p>

<h2>Lo que esto hace posible</h2>
<p>Como cada publicación es un dato estructurado en un repositorio que es mío
—y no algo encerrado dentro de la app de otro— puedo construir cosas encima.
Por ejemplo, me gustaría poner en un mapa todas las publicaciones
geolocalizadas (fotos, check-ins, reseñas…) para ver los sitios en los que he
estado. Eso solo es posible porque los datos son míos y están abiertos.</p>

<h2>Dónde más aparece</h2>
<p>Buena parte de lo que hay aquí se publica también en mis cuentas de
<a href="https://mastodon.social/@hhkaos">Mastodon</a> y
<a href="https://bsky.app/profile/rauljimenez.info">Bluesky</a>. Cuando es así,
esta copia es la canónica y la publicación en la red enlaza de vuelta a ella
—la IndieWeb lo llama <a href="https://indieweb.org/POSSE">POSSE</a> (publica en
tu propio sitio, sindica en otros). En cualquier caso, el registro completo y
permanente es el <a href="${SOURCE_REPO}">repositorio de GitHub</a>.</p>

<h2 id="why-not-shared">Por qué algunos posts no están en redes sociales</h2>
<p>Mucho de lo que hay aquí nunca llega a Mastodon ni a Bluesky, y es a
propósito:</p>
<ul>
<li>Es algo que quiero dejar registrado y no me importa que sea público, pero
que no es lo bastante actual, noticiable o útil como para meterlo en el
timeline de quien me sigue allí — prefiero no llenárselo con esto.</li>
<li>Además, algunos de estos tipos de post (una reseña, un RSVP, un «visto», un
check-in) no tienen forma sencilla de sindicarse a según qué plataforma: las
herramientas simplemente no existen, y muchas veces no compensa el esfuerzo.</li>
<li>Está aquí para después: para quien quiera conocerme un poco mejor, para
recuperar una recomendación que di en su momento, o simplemente porque quería
guardarlo.</li>
</ul>

<h2 id="reacting">Reaccionar a un post</h2>
<p>Cada página de post tiene un botón <strong>Responder</strong>. Si el post se
compartió en redes, enlaza a la copia en Mastodon o Bluesky —responde, dale me
gusta o compártelo allí y aparecerá aquí de vuelta. Dos cosas que conviene
saber: a diferencia de una red al uso, esto <em>no</em> es inmediato (puede
tardar unos minutos) y ocurre en ese otro sitio, no aquí. Si tienes web propia,
también puedes enviar un <a href="https://indieweb.org/Webmention">Webmention</a>
directamente desde el formulario.</p>

<h2 id="subscribe">Cómo suscribirse</h2>
<p>Este feed tiene un <a href="/feed.xml">feed Atom</a>. Pega
<code>posts.rauljimenez.info/feed.xml</code> —o simplemente la dirección de
este sitio— en cualquier lector de feeds (NetNewsWire, Feedly, Reeder,
Thunderbird, tu navegador…) y las publicaciones nuevas aparecerán ahí, sin
cuenta ni algoritmo de por medio. Además, cada página lo anuncia para
autodescubrimiento, así que la mayoría de lectores lo encuentran solo con la
URL. Mi <a href="https://www.rauljimenez.info/es/blog">blog</a> tiene sus
propios feeds (en inglés y español), enlazados igual.</p>

<h2 id="languages">Idiomas</h2>
<p>Escribo algunos posts en inglés y otros en español, según para quién sean.
No he encontrado una buena forma de publicarlo todo en ambos idiomas —traducir
a mano cada nota no es realista—, así que de momento cada post lleva un botón
🌐 que lo abre en Google Translate, y puedes filtrar el timeline por un solo
idioma.</p>

<h2>Por qué no usar sin más las redes sociales</h2>
<p>Porque las plataformas sociales que conocemos no son herramientas neutrales.
Sus incentivos no son los míos, pueden hacer desaparecer mi contenido o mi
cuenta, y la forma en que están diseñadas para retener la atención tiene costes
reales. Si suena abstracto, el documental
<a href="https://www.imdb.com/title/tt11464826/"><em>El dilema de las redes
sociales</em></a> lo explica bien. Tener esto bajo mi control es una pequeña
forma de no entrar en ese juego.</p>

<h2>Licencia</h2>
<p>Todo el <strong>contenido</strong> publicado en este sitio —texto, fotos— se
distribuye bajo licencia <a href="${LICENSE_URL}" rel="license"><strong>Creative
Commons Atribución 4.0 Internacional (CC&nbsp;BY&nbsp;4.0)</strong></a>. Eres
libre de compartirlo y adaptarlo, incluso comercialmente, siempre que me cites
(nombre + un enlace de vuelta). El código fuente del sitio, en el repositorio
de arriba, es un asunto aparte.</p>

<p style="margin-top:2rem"><a href="${BASE_URL}/">&larr; Volver al timeline</a>
· <a href="/feed.xml">RSS</a></p>
</article>`;

  const body = `${BACK_LINK}
<div class="i18n-en">${en}</div>
<div class="i18n-es">${es}</div>`;

  return page({
    title: "About this feed",
    body,
    repCard: false,
    og: {
      url: `${BASE_URL}/about/`,
      type: "website",
      description: "What this activity feed is, why it's self-hosted and not on a social platform, and how the content is licensed.",
    },
  });
}

async function main() {
  await mkdir(SITE_DIR, { recursive: true });
  await writeFile(path.join(SITE_DIR, ".nojekyll"), "");
  await writeFile(path.join(SITE_DIR, "CNAME"), "posts.rauljimenez.info\n");
  await copyFile("scripts/style.css", path.join(SITE_DIR, "style.css"));
  // Same favicon as www.rauljimenez.info (a copy, so the site is self-contained).
  await copyFile("scripts/favicon.ico", path.join(SITE_DIR, "favicon.ico"));

  // Media uploaded via Micropub (@indiekit/store-github writes it to `media/`).
  // Posts reference these by absolute URL under posts.rauljimenez.info, so the
  // files must be served from the Pages site verbatim — nothing else copies them.
  try {
    await cp("media", path.join(SITE_DIR, "media"), { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // no media/ folder yet is fine
  }

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

      const props = post.properties;
      const effectiveType = props.checkin ? "checkin" : type;
      index.push({
        type: effectiveType,
        url,
        published: props.published,
        entry: feedEntry(effectiveType, props, post.content, url),
        contentHtml: post.content ? renderMarkdown(post.content) : "",
      });
    }
  }

  index.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  await copyFile("scripts/timeline.js", path.join(SITE_DIR, "timeline.js"));
  await copyFile("scripts/webmentions.js", path.join(SITE_DIR, "webmentions.js"));
  await writeFile(path.join(SITE_DIR, "feed.xml"), buildFeed(index));

  await mkdir(path.join(SITE_DIR, "about"), { recursive: true });
  await writeFile(path.join(SITE_DIR, "about", "index.html"), renderAboutHtml());

  // Split the timeline into numbered pages. `/` is page 1; `/page/2/`, … hold
  // the rest. Each page stands alone (working prev/next links); timeline.js
  // stitches them into infinite scroll when it can.
  const intro = `<header class="site">
<h1 class="visually-hidden"><span class="i18n-en">Activity</span><span class="i18n-es">Actividad</span></h1>
<details class="intro-toggle">
<summary class="intro-toggle__btn"><span class="i18n-en">What is this?</span><span class="i18n-es">¿Qué es esto?</span><svg class="intro-toggle__chev" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg></summary>
<div class="page-intro">
<p class="i18n-en">The kind of thing people usually scatter across other companies' platforms — a note, a link, a photo, an Amazon or Google Maps review, a like on a YouTube video, an RSVP to an event, something I've read or watched — collected here on my own domain instead. Some of it is also posted to social media; some of it (a rating, a review) has nowhere else good to go; and some I don't share anywhere at all.</p>
<p class="i18n-es">El tipo de cosas que solemos repartir por las plataformas de otras empresas —una nota, un enlace, una foto, una reseña en Amazon o Google Maps, un me gusta en un vídeo de YouTube, un RSVP a un evento, algo que he leído o visto— recogidas aquí, en mi propio dominio. Parte se publica también en redes sociales; parte (una valoración, una reseña) no tiene otro sitio al que ir; y parte no la comparto en ningún lado.</p>
</div>
</details>
<p class="intro-about"><a href="/about/"><span class="i18n-en">About this feed, IndieWeb-style, and why &rarr;</span><span class="i18n-es">Sobre este feed, al estilo IndieWeb, y por qué &rarr;</span></a></p>
</header>`;

  const pageCount = Math.max(1, Math.ceil(index.length / PAGE_SIZE));
  for (let n = 1; n <= pageCount; n++) {
    const slice = index.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
    // Root-relative so the links + timeline.js fetch work on any host.
    const prev = n === 1 ? "" : n === 2 ? "/" : `/page/${n - 1}/`;
    const next = n < pageCount ? `/page/${n + 1}/` : "";

    const header = n === 1
      ? intro
      : `<header class="site"><h1 class="visually-hidden"><span class="i18n-en">Activity — page ${n} of ${pageCount}</span><span class="i18n-es">Actividad — página ${n} de ${pageCount}</span></h1><p class="page-intro"><span class="i18n-en">Page ${n} of ${pageCount} · <a href="${BASE_URL}/">newest &rarr;</a></span><span class="i18n-es">Página ${n} de ${pageCount} · <a href="${BASE_URL}/">más recientes &rarr;</a></span></p></header>`;

    const body = index.length
      ? `${header}\n${feedFilter()}\n${renderTimeline(slice)}\n${pager(prev, next)}`
      : `${intro}\n<p>Nothing public yet.</p>`;

    const html = page({
      title: n === 1 ? "Activity" : `Activity — page ${n} of ${pageCount}`,
      body,
      repCard: false,
      og: {
        url: n === 1 ? `${BASE_URL}/` : `${BASE_URL}/page/${n}/`,
        type: "website",
      },
    });

    if (n === 1) {
      await writeFile(path.join(SITE_DIR, "index.html"), html);
    } else {
      const dir = path.join(SITE_DIR, "page", String(n));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.html"), html);
    }
  }

  console.log(`Rendered ${index.length} public post(s) into ${SITE_DIR}/ (${pageCount} timeline page(s))`);
}

main();
