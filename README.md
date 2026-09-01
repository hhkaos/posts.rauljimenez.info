# indie.rauljimenez.info — activity store

Content store for a personal [Indiekit](https://getindiekit.com) lab instance
at `indie.rauljimenez.info`, used to experiment with
[IndieAuth](https://indieauth.spec.indieweb.org/) and
[Micropub](https://micropub.spec.indieweb.org/) without touching the main
site at [www.rauljimenez.info](https://www.rauljimenez.info/) (built with
Docusaurus, hosted separately).

## Structure

| Folder       | Post type | Notes                                   |
| ------------ | --------- | ---------------------------------------- |
| `notes/`     | note      | Short-form posts, explicit publish       |
| `bookmarks/` | bookmark  | Saved links — **private by default**     |
| `likes/`     | like      | Likes of external URLs — visibility set per post |
| `replies/`   | reply     | Replies to other posts, explicit publish |

Each file's YAML front matter includes a `visibility` property
(`public` / `unlisted` / `private`) as set by the Micropub client.

> [!NOTE]
> **This repository is public.** `visibility` is stored as metadata only —
> Indiekit does not enforce it as access control. Anything committed here is
> readable by anyone on GitHub, regardless of its `visibility` value.

## This is not the main site

This repo is not built or deployed anywhere. It is only read and written by
the Indiekit server via the GitHub API (`@indiekit/store-github`).
