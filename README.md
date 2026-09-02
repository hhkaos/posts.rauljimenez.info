# posts.rauljimenez.info — activity store

Content store for a personal [Indiekit](https://getindiekit.com) lab instance
running at `indie.rauljimenez.info` (kept private, not linked publicly),
used to experiment with
[IndieAuth](https://indieauth.spec.indieweb.org/) and
[Micropub](https://micropub.spec.indieweb.org/) without touching the main
site at [www.rauljimenez.info](https://www.rauljimenez.info/) (built with
Docusaurus, hosted separately).

## Running it locally

You only need [Node](https://nodejs.org/) 18+ (CI uses 22). No database, no
Indiekit — the renderer just reads the Markdown files in this repo.

```bash
npm install        # once

npm run dev         # build + serve + rebuild on every change
```

`npm run dev` prints a URL (`http://localhost:8787/`, or the next free port
if that's taken). Open it, edit a post file or `scripts/render.mjs` /
`scripts/style.css`, and it re-renders within ~150 ms — **refresh the
browser** to see it (there's no live-reload).

While previewing, permalinks and feed links point at the local server (via
the `PREVIEW_BASE` env var the dev server sets) so you can click around. The
logo in the header is still loaded from `www.rauljimenez.info`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Render `_site/` once (production URLs). |
| `npm run serve` | Serve the current `_site/` without rebuilding. |
| `npm run verify` | Parse the built HTML and check the author microformats2. |
| `node scripts/screenshot.mjs` | Regenerate the per-post OG / syndication PNGs (needs `npx playwright install chromium`). |

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

**Headings.** The navbar already marks the current section, so the
timeline's `<h1>` ("Activity" / "Actividad") would just repeat it — it's
kept in the DOM but `.visually-hidden` (off-screen, still read by screen
readers and counted for the outline / SEO), leaving the intro paragraph as
the visible masthead. Conversely, post pages whose type has no visible
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
**"🌐 Ver en español" / "🌐 See in English"** link (in the permalink row)
pointing at Google Translate's page proxy — free, no key; the browser's
native page translation is the more durable path and now fires correctly
because `<html lang>` is right.

`/about/` (`renderAboutHtml()`) explains what this feed is: a
platform-independent social timeline, the IndieWeb rationale
(`indieweb.org/why` + `/principles`), POSSE, the GitHub repo as the
canonical record, why not mainstream social media (*The Social Dilemma*),
and the content license. **All content on the site is CC BY 4.0**; the
`/about/` page is the canonical statement of that.

### Syndication links (POSSE / `u-syndication`)

Posts syndicated to Mastodon/Bluesky carry a `syndication:` list (status
URLs) in their front matter, written back by Indiekit's
`@indiekit/endpoint-syndicate`. `render.mjs` turns each into an
`<a class="u-syndication">` link ("Also posted on Mastodon, Bluesky") under
the permalink — the IndieWeb-standard way to point the canonical post at
its copies, and what Bridgy-style backfeed matches against.

This repo itself is not built or deployed to www.rauljimenez.info. It is
read and written by the Indiekit server via the GitHub API
(`@indiekit/store-github`), and separately rendered by its own GitHub Action
to `posts.rauljimenez.info` — a static, human- and Webmention-receiver
-readable view of the public subset of this content.
