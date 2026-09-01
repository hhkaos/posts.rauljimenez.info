# posts.rauljimenez.info — activity store

Content store for a personal [Indiekit](https://getindiekit.com) lab instance
running at `indie.rauljimenez.info` (kept private, not linked publicly),
used to experiment with
[IndieAuth](https://indieauth.spec.indieweb.org/) and
[Micropub](https://micropub.spec.indieweb.org/) without touching the main
site at [www.rauljimenez.info](https://www.rauljimenez.info/) (built with
Docusaurus, hosted separately).

## Structure

| Folder       | Post type |
| ------------ | --------- |
| `notes/`     | note      |
| `bookmarks/` | bookmark  |
| `likes/`     | like      |
| `replies/`   | reply     |
| `rsvp/`      | rsvp      |
| `reposts/`   | repost    |
| `events/`    | event     |

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
GitHub Pages            -- posts.rauljimenez.info
     |
     v
scripts/send-webmentions.mjs  -- sends Webmentions for public bookmark/like/
                                  reply/rsvp/repost posts with an external
                                  target, once their page is live. Idempotent
                                  via .webmentions-sent.json. (Events are not
                                  sent — an h-event announces something, it
                                  isn't a response to another page.)
```

This repo itself is not built or deployed to www.rauljimenez.info. It is
read and written by the Indiekit server via the GitHub API
(`@indiekit/store-github`), and separately rendered by its own GitHub Action
to `posts.rauljimenez.info` — a static, human- and Webmention-receiver
-readable view of the public subset of this content.
