# posts.rauljimenez.info — activity store

Content store for a personal [Indiekit](https://getindiekit.com) lab instance
running at `indie.rauljimenez.info` (kept private, not linked publicly),
used to experiment with
[IndieAuth](https://indieauth.spec.indieweb.org/) and
[Micropub](https://micropub.spec.indieweb.org/) without touching the main
site at [www.rauljimenez.info](https://www.rauljimenez.info/) (built with
Docusaurus, hosted separately).

## Running it locally

You only need [Node](https://nodejs.org/) 20+ (CI uses 22). No database, no
Indiekit — the renderer just reads the Markdown files in this repo.

```bash
npm install        # once

npm run dev         # build + serve + rebuild on every change
```

`npm run dev` binds `0.0.0.0` and prints two URLs — the detected LAN IP
(`http://192.168.x.x:8787/`, for opening from another machine on the
network) and `http://localhost:8787/` — or the next free port if 8787 is
taken. Edit a post file or `scripts/render.mjs` / `scripts/style.css` and
it re-renders within ~150 ms — **refresh the browser** to see it (no
live-reload). `HOST=127.0.0.1 npm run dev` forces loopback-only;
`npm run serve` is loopback-only and doesn't rebuild.

While previewing, every internal link — permalinks, the "← All activity"
back link, the `/about/` link in the masthead, feed links — points at the
local server (via the `PREVIEW_BASE` env var the dev server sets), so you
can click around. `serve.mjs` re-renders once on startup for the real port,
so `npm run serve` alone is enough; `--watch` (`npm run dev`) only adds
rebuild-on-change. Links that are *meant* to leave the feed (the header
logo, "my own site" → `www.rauljimenez.info`, the Google-Translate link)
stay absolute. `PREVIEW_BASE` uses the LAN IP under `npm run dev` (auto-
detected — prefers `192.168.*`, then `10.*`; `PREVIEW_HOST=…` overrides),
so those internal links resolve for whoever opens it.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Render `_site/` once (production URLs). |
| `npm run serve` | Serve the current `_site/` without rebuilding. |
| `npm run verify` | Parse the built HTML and check the author microformats2. |
| `node scripts/screenshot.mjs` | Regenerate the per-post OG / syndication PNGs (needs `npx playwright install chromium`). |
| `npx webmentions-snapshot --domain posts.rauljimenez.info --out scripts/webmentions-snapshot.json` | Refresh the committed webmention.io snapshot (needs `WEBMENTION_IO_TOKEN`; CI does this daily). |

`_site/` is git-ignored and rebuilt from scratch each time; deleting it is
always safe.

## Structure

| Folder       | Post type | Notes                                        |
| ------------ | --------- | -------------------------------------------- |
| `notes/`     | note      |                                              |
| `articles/`  | article   | long-form, has a title                       |
| `photos/`    | photo     | one or more images + caption                 |
| `bookmarks/` | bookmark  |                                              |
| `likes/`     | like      |                                              |
| `replies/`   | reply     |                                              |
| `rsvp/`      | rsvp      |                                              |
| `reposts/`   | repost    |                                              |
| `events/`    | event     |                                              |
| `checkins/`  | checkin   | `checkin` = h-card of the venue              |
| `reviews/`   | review    | h-review: `item`, `rating` (1–5), body       |
| `reads/`     | read      | `read-of` h-cite + `read-status`             |
| `watches/`   | watch     | `watch-of` h-cite, optional `rating`         |
| `listens/`   | listen    | `listen-of` h-cite                           |

> A check-in that also carries a `photo` is stored by Indiekit under
> `photos/` with `post-type: photo` (its Post Type Discovery can't be
> reordered). `render.mjs` renders any post with a `checkin` property as a
> check-in regardless of folder.

An optional `lang:` property (`es` / `en`) pins the post's language;
without it the language is detected from the body (see *Content language
per post* below).

Each file's YAML front matter includes a `visibility` property
(`public` / `unlisted` / `private`). **Everything created through the
Indiekit server defaults to `public`** — it's an explicit act of
publishing. The default is applied only when a Micropub client doesn't send
its own value (set in the Indiekit server's `indiekit.config.js`, not in
this repo); a client can still mark an individual post `private`.

> [!NOTE]
> **This repository is public.** `visibility` is stored as metadata only —
> neither Indiekit nor this repo enforce it as real access control. Anything
> committed here is readable by anyone with the raw GitHub URL, regardless of
> its `visibility` value. `visibility` only decides what gets rendered on
> [posts.rauljimenez.info](https://posts.rauljimenez.info) and what triggers
> an outgoing Webmention — see below.

## Publishing pipeline

```
push to main
     |
     v
scripts/render.mjs      -- renders visibility=public posts as static HTML
     |
     v
scripts/verify-mf2.mjs  -- parses the generated HTML with microformats-parser
                            and fails the build if the author markup regresses
     |
     v
GitHub Pages            -- posts.rauljimenez.info
     |
     v
scripts/send-webmentions.mjs  -- sends Webmentions for public bookmark/like/
                                  reply/rsvp/repost/review/read/watch/listen
                                  posts with an external target, once their
                                  page is live. Idempotent via
                                  .webmentions-sent.json. (Events and
                                  check-ins are not sent — they announce
                                  something rather than respond to a page.)
```

### Author identity (microformats2)

`render.mjs` emits author markup that Webmention receivers (e.g.
webmention.io) can read:

- a hidden **representative h-card** on every *post* page — `p-name`
  (`Raúl Jiménez Ortega`), `u-url` + `rel="me"` to `www.rauljimenez.info`,
  and an absolute `u-photo`;
- a nested **`p-author` h-card** inside every post's `h-entry` / `h-event`
  / `h-review`, with the same name, url and photo.

The index page deliberately carries **no** h-card: it has no `h-entry`, and
a lone top-level h-card makes XRay (the parser webmention.io verifies with)
treat the whole page as a person card and stop looking for target links,
which would break Webmentions sent *from* the index.

The name/url/photo are the `AUTHOR_*` constants at the top of `render.mjs`.
`scripts/verify-mf2.mjs` (run in CI) parses the built HTML and fails if any
of this regresses.

### Home timeline

The landing page is a reverse-chronological timeline grouped under a
per-day heading, with each post as a card (`li.fc`) carrying:

- the type **badge** + the local **time** (`Europe/Madrid`, `TZ` in
  `render.mjs`);
- an **action line** for response-type posts — `📝 Reviewed <item>`,
  `📚 Finished reading <book> by <author>`, `⭐ Liked <title>`,
  `✅ Going to <event>`, … — so a review/like/reply reads at a glance
  without opening it. Icons mirror the syndicator's `status-text.js`;
- a **rating** (`★★★★☆`) when the post has one;
- a one-line body **excerpt**;
- any **image**: `properties.photo` for photo/check-in posts, otherwise
  the first inline Markdown image in the body (reviews, reads, notes);
- a small `🔗 host` context line where the linked title alone isn't
  obviously external.

Card content per type is built by `feedEntry()` / `renderFeedCard()`. The
timeline still carries no microformats (no `h-feed`/`h-entry`) — same
reason the index has no h-card (above).

### Pagination + infinite scroll

The timeline is split into pages of `PAGE_SIZE` (20; override with the
`TIMELINE_PAGE_SIZE` env var when testing) — `/` is page 1, the rest are
`/page/2/`, `/page/3/`, … Each page stands alone with working
`← Newer` / `Older →` links (`rel="prev"`/`rel="next"`), so it works with
JS disabled. `scripts/timeline.js` (copied to `_site/` next to `style.css`,
loaded `defer` on every page) is a small progressive enhancement: an
`IntersectionObserver` on the `#timeline-end` sentinel fetches the next
page, splices its `.timeline` cards in — deduping a day heading repeated at
the seam — and follows that page's own sentinel until exhausted.

### Atom feed

`scripts/render.mjs` writes `_site/feed.xml` (Atom 1.0) from the same sorted
index it already builds — no extra pass over the content tree. Newest
`FEED_MAX` (50) posts; each entry carries the timeline action line + the
rendered Markdown body + first image as `content type="html"`. Every page
links it via `<link rel="alternate" type="application/atom+xml">`, and the
footer / `/about/` link it visibly.

**Feed autodiscovery** (`feedLinks(lang)`): every page's `<head>` also
advertises both languages of the `www.rauljimenez.info` Docusaurus blog
feeds (`/blog/atom.xml` + `/rss.xml`, and the `/es/` pair), each with
`hreflang` and a language-tagged `title`. All are emitted statically — a
feed reader / crawler reads raw HTML and runs no JS, so JS filtering would
just hide them; instead the page's **content language only orders** its
matching blog feeds first, so that's the "primary" one a reader offers.

### Titles, favicon & social sharing

- **`<title>` / `og:title`** are always branded with the full name —
  `fullTitle()` → `Raúl Jiménez Ortega | <page>` (`… | Activity`,
  `… | About this feed`, `… | <post title>`), matching
  `www.rauljimenez.info`.
- **Favicon**: `scripts/favicon.ico` is a copy of
  `www.rauljimenez.info/img/favicon.ico`, copied to `_site/favicon.ico` and
  linked from every page (so the site is self-contained, not hotlinking).
- **Open Graph + Twitter** tags are emitted on **every** page by `page()`
  (previously only post pages had them): `description`, `author`,
  `canonical`, `og:site_name/locale/type/title/description/url/image`,
  `og:image:alt`, `twitter:card=summary_large_image` + title/description/
  image/alt, and `article:published_time` / `article:author` on posts.
- **`og:image`**: post pages use their own `screenshot.png`; the timeline,
  `/about/` and any fallback use **`_site/social-card.png`** — a **1200×630**
  (the size every network recommends) shot of the landing page written by
  `scripts/screenshot.mjs` (`shootSocialCard()`), alongside the per-post
  screenshots. `og:image:width/height` are emitted only for that card
  (post screenshots are cropped to the post, so their size varies).

### Shared header + `/about/`

Every page carries a fixed navbar that mirrors the Docusaurus navbar on
`www.rauljimenez.info` (logo, links back to the main site's sections, the
orange `#f05924` accent, `system-ui` font, matched light/dark palette) so
the two sites read as one. The logo is **hotlinked** from
`www.rauljimenez.info/img/rauljimenez.info.png` (same owner) — vendor it
into this repo if that dependency is unwanted. Nav config is the
`NAV_LINKS` / `LOGO_URL` constants in `render.mjs`.

The navbar has the same **light/dark toggle** and **language selector** as
the main site. Both are driven by `HEAD_INIT_SCRIPT` (inline in `<head>`,
runs before first paint so there's no flash) which sets `[data-theme]` and
`[data-lang]` on `<html>`; `style.css` shows the right palette / language
variant off those attributes. Language is picked from `?lang=es|en`
(remembered in `localStorage`), else `localStorage`, else
`navigator.languages` — so a visitor arriving from
`www.rauljimenez.info/es/` keeps Spanish header, nav, intro and footer.
Both language variants are emitted in the HTML (`.i18n-en` / `.i18n-es`);
with no JS the English default shows.

**Mobile (`≤48rem`)** — the links + language/theme controls move into a
left **slide-in drawer** (backdrop, `✕`, `Esc` / backdrop / link-tap all
close it, body scroll locked), mirroring the Docusaurus navbar's drawer.
The hamburger + drawer chrome only exist below the breakpoint; on desktop
`.site-nav__menu` is `display:contents` so its children lay out in the nav
row exactly as before. Wiring is a few lines appended to the
`HEAD_INIT_SCRIPT` `DOMContentLoaded` block (toggles `.site-nav.is-open` +
`body.nav-open`).

**Timeline top bar** (`feedFilter(includeIntro)` → `.feed-bar`, page 1 has
no visible `<header>`, just the `.visually-hidden` `<h1>`). One row,
border under it:

- **Language filter** (left): a pill group "All / English / Español".
  Picking one sets `[data-feed-lang]` on `<html>` (remembered in
  `localStorage`, applied pre-paint by `HEAD_INIT_SCRIPT`); CSS hides
  `li.fc:not([lang=…])` and — via `:has()` — day headings left empty.
  Opt-in: "All" is the default, nothing hidden until chosen, no-JS shows
  everything. Works with the infinite scroll for free (pure CSS on
  spliced-in cards).
- **"What is this? / ¿Qué es esto?"** (right): a collapsed
  `<details class="intro-toggle">`. Closed it costs no vertical space; open,
  the `<details>` goes `flex-basis:100%` so the panel — descriptive intro
  (broader than "social network" — Amazon/Maps reviews, YouTube likes,
  RSVPs, things shared nowhere) + the `/about/` link (`.page-intro__about`)
  — fills the row below. From `30rem` up the `<summary>` is
  `position:absolute` top-right of `.feed-bar` so it *doesn't move* when
  the panel opens (`.feed-filter__langs` gets `padding-right` to stay
  clear); narrower, it flows and wraps under the pills. No inline RSS link
  — `/about/#subscribe` covers that. A closed `<details>` hides its content
  via `content-visibility` (not CSS), so the OG-card screenshot sets
  `details.open` in JS rather than fighting it, then hides the summary +
  about link.

**Headings.** The navbar already marks the current section, so the
timeline's `<h1>` ("Activity" / "Actividad") would just repeat it — it's
kept in the DOM but `.visually-hidden` (off-screen, still read by screen
readers and counted for the outline / SEO), so the timeline top bar is the
first visible thing. Conversely, post pages whose type has no visible
title (note, bookmark, like, reply, RSVP, repost, check-in, read, watch,
listen, untitled photo/review) now get a `.visually-hidden` `<h1>` so every
page has exactly one. Visible titles (articles, events, named
photos/reviews) are unchanged.

The selector only switches the **chrome** — it sets `[data-lang]`, *not*
`<html lang>`. `<html lang>` is set per page from the **content** language
(see below) and must stay put so the browser's own "translate this page"
offer targets the right language.

### Content language per post

Posts are written in Spanish or English, freely mixed in the timeline.
Each post's language is resolved by `postLang()` in `render.mjs`:

- an explicit **`lang:` in the front matter** (`es` / `en`) always wins —
  the manual override;
- otherwise `franc` (`franc-min`, offline, no API) guesses from the body,
  restricted to Spanish/English;
- anything it can't call confidently falls back to `SITE_DEFAULT_LANG`
  (`en` — also the language of the feed metadata and `/about/`).

Detection is reliable for a sentence or more of real prose; it can miss on
very short or place-name-heavy posts (e.g. an English note full of Spanish
toponyms) — add `lang: en` / `lang: es` to that file to fix it.

The resolved language is emitted as `<html lang>` on the post page,
`lang=""` on the post `<article>` and on each timeline card `<li class="fc">`,
and `xml:lang` on each Atom `<entry>`. Post pages also get a small
**"🌐 Ver en español" / "🌐 See in English"** link (in the footer row under
the post) pointing at Google Translate's page proxy — free, no key, always
built from the canonical URL; the browser's native page translation is the
more durable path and now fires correctly because `<html lang>` is right.

### Post header / footer rows

The **date** in a post's meta row *is* the permalink — it carries
`u-url` + `dt-published` (standard h-entry pattern), so there's no separate
visible "Permalink" line lower down (`renderMetaRow(type, published, url)`).
The **author** is never shown — one person publishes everything here, so a
byline is noise — but a nested `p-author h-card` stays in the markup
(`hidden`) so Webmention consumers that read a mention's author from mf2
still get name/url/photo. The footer row under a post is therefore just the
"translate" link, when it applies.

`/about/` (`renderAboutHtml()`) explains what this feed is: a
platform-independent social timeline, the IndieWeb rationale
(`indieweb.org/why` + `/principles`), POSSE, the GitHub repo as the
canonical record, **what owning structured data makes possible** (a future
map of geotagged posts), **why some posts aren't on social media**
(`#why-not-shared` — not timely/useful enough for followers there, no clean
syndication path for a review/RSVP/etc., kept as a personal record),
**how reacting to a post works** (`#reacting` — the Respond button, that
backfeed isn't instant and happens on the other site), **how to subscribe**
(`#subscribe`), **languages** (`#languages` — posts are written in one
language or the other, no full bilingual pipeline, hence the per-post
Google-Translate button + the timeline language filter), why not mainstream
social media (*The Social Dilemma*), and the content license. **All content
on the site is CC BY 4.0**; the `/about/` page is the canonical statement
of that. It's **fully bilingual** — `renderAboutHtml()` emits a complete
`.i18n-en` and `.i18n-es` `<article>` and `[data-lang]` shows one.

Because both language copies carry the same section `id`, a native anchor
jump can land on the hidden one; `respond.js`' `initHashJump` re-jumps
to the visible copy (on load + `hashchange`, and the nav language toggle
fires a synthetic `hashchange`). `.prose h2[id]` gets `scroll-margin-top`
to clear the fixed navbar.

### "Respond" block + syndication links (POSSE / `u-syndication`)

Every post page ends with a **`<details class="respond-toggle">`** (built by
`respondSection()` in `render.mjs`, inside the `h-entry`, hidden from the OG
screenshot). Collapsed by default — just a pill-shaped "Respond / Responder"
`<summary>` button — so it costs no vertical space until opened. Native
disclosure: works with no JS (`respond.js` only adds a
scroll-into-view when it opens on a phone, `≤34rem`). Open, it becomes a
lightly tinted card (no horizontal separator rules); on mobile the button
is full-width and the form controls stack. Inside the `<section class="respond">`:

- **Network buttons** — for each `syndication:` entry in the front matter
  (status URLs written back by `@indiekit/endpoint-syndicate` after a
  Mastodon/Bluesky cross-post), a button with the network's logo linking to
  that copy, where a reader can reply / like / boost natively. Each button
  carries `class="u-syndication"`, so these *are* the IndieWeb POSSE links
  that point the canonical post at its copies and that Bridgy-style backfeed
  matches against — there is no longer a separate "Also posted on …" line.
  A hint links "it flows back here" → `/about/#reacting`. When the post has
  **no** `syndication:`, that block is instead an italic "not cross-posted
  to social media — why?" linking `/about/#why-not-shared`. Both links are
  root-relative so they resolve locally under preview too.
- **Webmention form** — a plain `method="post"` form to the shared
  webmention.io endpoint (`WEBMENTION_ENDPOINT`), `target` = the canonical
  post URL, `source` = a URL the reader types. It posts to a hidden iframe
  so it works with JS off; `respond.js` swaps in a thank-you line on
  submit. Verified mentions then show up in the "Responses from around the
  web" section above it (and fire the push+email pipeline).

### Received Webmentions (shared `@hhkaos/webmentions-widget`, baked in at build time)

Every page advertises a Webmention endpoint
(`<link rel="webmention" href="https://webmention.io/links.rauljimenez.info/webmention">`
— the hosted webmention.io account shared with `www.`/`links.rauljimenez.info`).

The likes / reposts / replies / mentions themselves are **rendered into the
static HTML by `render.mjs` at build time** — there is *no* per-visitor fetch
to webmention.io (their API returns intermittent 502s whose nginx error page
carries no CORS header, so in a browser one blip blanks the section). The
logic — target-URL expansion, dedup/grouping, mojibake stripping, excerpting,
`textContent`-only rendering — is the shared package
[`@hhkaos/webmentions-widget`](https://github.com/hhkaos/webmentions-widget)
(`0.3.0`), one implementation for this site,
`links.rauljimenez.info` and `hhkaos.github.io`. See
[`hhkaos/webmentions-widget#1`](https://github.com/hhkaos/webmentions-widget/issues/1).

The data comes from **`scripts/webmentions-snapshot.json`** — a committed
snapshot of every mention webmention.io holds for `posts.rauljimenez.info`,
refreshed daily by `.github/workflows/webmentions-snapshot.yml`
(`npx webmentions-snapshot`, authenticated with the `WEBMENTION_IO_TOKEN` repo
secret; the same job also runs on `workflow_dispatch` — with a `full` input —
and `repository_dispatch: webmention`). Committing a refreshed snapshot to
`main` re-triggers `publish.yml`, so the site redeploys with the new mentions.

- **Post pages** carry a `<section id="webmentions">` (the `page()` helper
  adds it on the same pages that get the representative h-card — its
  `webmentions` option defaults to `repCard`, so the index and `/about/`
  don't). `render.mjs` fills it via the package's `renderGroups()` against a
  `linkedom` document: likes / reposts / bookmarks as a per-property
  tinted-glyph facepile (`♥` / `↻` / `⚑` + count), replies + mentions as
  `h-cite` cards, bilingual `{en, es}` labels as CSS-toggled `.i18n-*` spans,
  and a small "Updated *date*" line (the snapshot is always a little behind).
  A page with no mentions renders no section at all.
- **Timeline pages** get a compact `♥ n · ↻ n · ↩ n` line per `.fc` card
  (`webmentionCountLine()`, built from the same `groupWebmentions()` output;
  replies + mentions fold into `↩`). No `MutationObserver` is needed — the
  cards the infinite scroll splices in already carry their own line.

`screenshot.mjs` hides both `.webmentions` and `.fc-reactions`. Everything is
keyed on the real production URL via `toCanonical()`, so `npm run dev`
(`PREVIEW_BASE`) shows the real mentions baked in without any preview-only
attributes.

The only remaining client script for this area is **`scripts/respond.js`**
(`defer`, copied to `_site/` next to `style.css` / `timeline.js`): the
`#hash` deep-jump for `/about`'s bilingual sections and the two "Respond"
niceties (scroll-into-view on a phone, swap the form for a thank-you). These
are site-specific and stay local.

Reactions on the Mastodon/Bluesky copies flow in via **Bridgy**
(<https://brid.gy>, backfeed only, publishing disabled) — it watches the
syndicated accounts and posts a Webmention to the original for every
like/reply/repost there. `posts.rauljimenez.info` must be a registered site on
the webmention.io account for those to be accepted.

This repo itself is not built or deployed to www.rauljimenez.info. It is
read and written by the Indiekit server via the GitHub API
(`@indiekit/store-github`), and separately rendered by its own GitHub Action
to `posts.rauljimenez.info` — a static, human- and Webmention-receiver
-readable view of the public subset of this content.
