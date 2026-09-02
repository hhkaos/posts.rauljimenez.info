# posts.rauljimenez.info — activity store

Content store for a personal [Indiekit](https://getindiekit.com) lab instance
running at `indie.rauljimenez.info` (kept private, not linked publicly),
used to experiment with
[IndieAuth](https://indieauth.spec.indieweb.org/) and
[Micropub](https://micropub.spec.indieweb.org/) without touching the main
site at [www.rauljimenez.info](https://www.rauljimenez.info/) (built with
Docusaurus, hosted separately).

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
