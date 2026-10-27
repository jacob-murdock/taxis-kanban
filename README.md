# Taxis Kanban

**A realtime collaborative kanban on Cloudflare Workers, Durable Objects and Yjs.**

Make as many boards as you like, each with its own columns. Everyone on a board sees cards appear and move as they happen. Open a card and several people can edit it at once: edits merge on their own, with no save button and no conflict dialog. Each card keeps a field-level history of what changed. Access is gated by magic-link sign-in and per-board roles.

---

## Features

- **Magic-link sign-in.** Email a one-time link; a signed session cookie keeps you in. Mail goes through Resend when configured, otherwise the link is logged to the Worker console.
- **Per-board roles.** Owner, editor, and viewer. Owners manage members and invites; editors change the board and cards; viewers watch live but cannot write.
- **Board list.** Create, rename, archive and restore boards you belong to.
- **Live boards.** New boards start with To do / Doing / Done. Add, rename, reorder and delete columns, then drag cards within or between columns. Every open copy of the board updates.
- **Live card pages.** Title, assignee, due date and labels are shared fields. The body is a shared text document that merges character by character, so two people typing in different places don't overwrite each other.
- **Change history.** Every card edit is recorded with author, old and new value, and shown on the card page.
- **Archive and delete.** Archived cards leave their column and can be restored. Deleted cards are tombstoned, so a stale client can't bring them back.
- **Reconnects on its own.** Clients reconnect with backoff and resync on arrival. Logout, a removed membership, or a role change closes that person's live sockets. A role change reloads the page if you still belong.
- **No build framework.** The client is plain HTML, CSS and ES modules. Yjs is bundled locally by esbuild, so nothing loads from a CDN.

## Architecture

```
browser ──cookie + HTTP /api/*──▶ Worker ──▶ AuthDO     (one: links, sessions, memberships, invites)
        ──WebSocket (Yjs)──────▶        ──▶ CatalogDO  (one: the board list)
                                        ──▶ BoardDO    (one per board)
                                        ──▶ JobDO      (one per card)
        ─ optional ─▶ Resend
```

- **Worker** (`src/index.js`, `src/routes/`) validates sessions and roles, routes `/api/*` and WebSocket upgrades to the right Durable Object, strips client-supplied actor headers and sets trusted identity, and serves `app/` as static assets. Signed-out visitors to a well-formed `/b/…` path are sent to sign in (the same redirect whether or not that board exists). Signed-in non-members get the same `404.html` as a missing board.
- **AuthDO** is a singleton (`idFromName("auth")`). It stores magic-link hashes, a per-email session generation counter (logout bumps it), memberships, invites, and rate limits. At this scale one AuthDO hit per gated request is fine.
- **YjsRoom** (`src/durable-objects/yjs-room.js`) is the shared base. It owns one `Y.Doc`, accepts [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), sends each new client the full state, and persists the encoded state in Durable Object storage. Socket attachments carry `{email, role}` for authorship and revoke.
- **CatalogDO** holds the board list (id, name, archived, created time). BoardDO keeps it in sync. The Worker filters the catalog snapshot to the caller's memberships.
- **BoardDO** holds one board: its name, an ordered array of columns, and a map of card summaries (title, column, rank, assignee, due, labels, archived).
- **JobDO** holds one card document: a map of fields plus a `Y.Text` body and a labels array. A debounced observer diffs each change against the last snapshot, writes it to a `changelog` table (with the actor's email), and pushes summary fields to BoardDO. Viewer sockets are read-only: inbound updates are dropped.

**Who writes what.** The board socket is read-only. Board and column changes, card creation, moves, archive and delete all go over HTTP and require editor (or owner where noted). The card socket is writable for editors and owners; viewers subscribe only. The server reverts protected keys (`id`, `boardId`, `columnId`) and clamps field lengths.

**Ordering.** Cards carry integer ranks spaced 1024 apart. A move takes the midpoint of its neighbours and renumbers the column when the gap runs out.

Each document has one Durable Object as its single-threaded authority, and Yjs merges concurrent edits, so there are no version numbers or 409s. The body merges per character; scalar fields are last-writer-wins.

### Auth

**Session cookie** `tk_session` is HMAC-signed with `SESSION_SECRET` (14-day TTL, sliding refresh on `/api/me`, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS). Logout bumps the AuthDO generation counter so every device for that email is signed out, and closes that person's board and card sockets. Mutating `/api/*` requests need a matching `Origin` (and `Content-Type: application/json` except bodyless DELETE); WebSocket upgrades need a matching `Origin`. Authenticated API responses and board/card HTML are `Cache-Control: no-store`. Pages send `X-Frame-Options: DENY` / `frame-ancestors 'none'` so the magic-link confirm page cannot be clickjacked.

**Magic links** are single-use, 15-minute tokens. `GET /api/auth/callback` shows a confirm page; `POST /api/auth/consume` burns the token and sets the cookie (defeats mail-scanner prefetch). The post-login `next` path may only be `/`, an invite URL, or a board or card page.

**Invites** are shareable URLs (`/invite?token=…`), single-use, 7-day expiry, for editor or viewer. Accepting while already a member burns the token and leaves the existing role unchanged. Invite email via Resend is out of scope.

**Roles**

| Role | Can |
|---|---|
| owner | Everything editors can, plus rename/archive the board, manage members, create invites |
| editor | Change columns and cards (HTTP + card socket) |
| viewer | Read snapshots and live sockets; no writes |

A board with no owner membership fails closed. Creating a board makes you the owner.

### HTTP API

`:board` and `:card` are opaque ids (`board_<uuid>`, `card_<uuid>`). Errors are JSON `{ "error": "..." }` with a 4xx status. Board and card routes require a session and the minimum role below. Catalog and auth routes as noted.

| Route | Method | Min role / access | Does |
|---|---|---|---|
| `/api/health` | GET | public | Health check |
| `/api/auth/request` | POST `{email}` | public | Request magic link (always same 200 body) |
| `/api/auth/callback?token=` | GET | public | Confirm page (does not consume) |
| `/api/auth/consume` | POST `{token}` | public | Burn link → Set-Cookie |
| `/api/auth/logout` | POST | session | Bump generation, clear cookie |
| `/api/me` | GET | session | `{ email }`; refreshes cookie |
| `/api/catalog/snapshot` | GET | session | Boards you belong to, each with `role` |
| `/api/boards` | POST `{name}` | session | Create board; caller becomes owner |
| `/api/boards/:board` | PATCH `{name?, archived?}` | owner | Rename or archive |
| `/api/boards/:board/ws` | GET (upgrade) | viewer | Board Yjs room (read-only) |
| `/api/boards/:board/snapshot` | GET | viewer | Board JSON + caller's `role` |
| `/api/boards/:board/columns` | POST `{name}` | editor | Add a column |
| `/api/boards/:board/columns/order` | POST `{ids}` | editor | Reorder columns |
| `/api/boards/:board/columns/:column` | PATCH `{name}` / DELETE | editor | Rename, or delete an empty column |
| `/api/boards/:board/cards` | POST `{title, columnId?}` | editor | Create a card |
| `/api/boards/:board/cards/:card/move` | POST `{columnId, beforeId?}` | editor | Move a card |
| `/api/boards/:board/cards/:card/archive` | POST `{archived}` | editor | Archive or restore |
| `/api/boards/:board/cards/:card` | DELETE | editor | Delete (tombstone) |
| `/api/boards/:board/cards/:card/ws` | GET (upgrade) | viewer | Card Yjs room (writes need editor+) |
| `/api/boards/:board/cards/:card/snapshot` | GET | viewer | Card JSON + caller's `role` |
| `/api/boards/:board/cards/:card/history?limit=&before=` | GET | viewer | Changelog, newest first |
| `/api/boards/:board/invites` | POST `{role}` | owner | Create invite (`role`: editor \| viewer) |
| `/api/boards/:board/members` | GET | owner | List members |
| `/api/boards/:board/members/:email` | PATCH `{role}` / DELETE | owner (or self to leave) | Change role or remove; not the last owner |
| `/api/invites/accept` | POST `{token}` | session | Join board from invite |

### Pages

| Path | Page |
|---|---|
| `/` | Board list + sign-in |
| `/invite?token=` | Accept invite |
| `/b/:board` | Board (members UI for owners) |
| `/b/:board/c/:card` | Card |

## Running

```sh
npm ci
cp .dev.vars.example .dev.vars   # set SESSION_SECRET
npx wrangler dev --local
```

Open http://localhost:8787. Sign in with any email; when `RESEND_API_KEY` is unset the magic link is printed in the wrangler console. Wrangler runs `npm run build:client` first, which bundles Yjs into `app/js/vendor/`.

Local Durable Object state lives in `.wrangler/`. Boards created before auth have no members and are unreachable after gating lands — delete `.wrangler/` (or recreate boards) to start fresh.

Deploy with `npx wrangler deploy`, then set secrets:

```sh
npx wrangler secret put SESSION_SECRET   # required; long random string
npx wrangler secret put RESEND_API_KEY   # optional; real email
```

## Configuration

`wrangler.toml` defines the Worker, `AUTH_DO`, `CATALOG_DO`, `BOARD_DO` and `JOB_DO` bindings (SQLite migrations through `v3`), and the `app/` asset directory. `run_worker_first` lets the Worker check page routes before assets are served. Limits and id formats live in `src/lib/constants.js`.

| Name | Where | Required | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | `.dev.vars` / `wrangler secret` | yes | Signs the session cookie. Unset → auth routes 500; nothing gated is reachable. |
| `RESEND_API_KEY` | secret | no | Send magic links via Resend; otherwise log to the Worker console. |
| `MAIL_FROM` | `[vars]` | no | From address when Resend is set (needs a verified domain for real delivery). |
| `APP_URL` | `[vars]` | no | Origin used in emailed links. Unset → request origin (not a raw `Host` header). |

Copy `.dev.vars.example` to `.dev.vars` for local dev (`.dev.vars` is gitignored).

## Layout

```
src/
  index.js                  Worker entry, page routes, CSRF
  routes/                   API routing (auth, boards, cards, members, DO helpers)
  durable-objects/
    yjs-room.js             shared Yjs room base, tombstones, revoke
    auth-do.js              magic links, sessions, memberships, invites
    catalog-do.js           board list
    board-do.js             board: columns, card summaries, ranks
    job-do.js               card document, changelog, board sync
  lib/                      auth, email, csrf, session, constants, ranks, fields, …
app/
  index.html  board.html  card.html  invite.html  404.html  css/app.css
  js/
    yjs-sync.js             client room connection
    auth.js  invite.js  boards.js  board.js  card.js  card-model.js  config.js
    vendor/                 bundled Yjs (generated)
```

## License

[MIT](LICENSE) © 2026 Jacob Murdock
