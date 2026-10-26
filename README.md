# Taxis Kanban

**A realtime collaborative kanban on Cloudflare Workers, Durable Objects and Yjs.**

Make as many boards as you like, each with its own columns. Everyone on a board sees cards appear and move as they happen. Open a card and several people can edit it at once: edits merge on their own, with no save button and no conflict dialog. Each card keeps a field-level history of what changed.

---

## Features

- **Board list.** Create, rename, archive and restore boards. The list updates live.
- **Live boards.** New boards start with To do / Doing / Done. Add, rename, reorder and delete columns, then drag cards within or between columns. Every open copy of the board updates.
- **Live card pages.** Title, assignee, due date and labels are shared fields. The body is a shared text document that merges character by character, so two people typing in different places don't overwrite each other.
- **Change history.** Every card edit is recorded with its old and new value and shown on the card page.
- **Archive and delete.** Archived cards leave their column and can be restored. Deleted cards are tombstoned, so a stale client can't bring them back.
- **Reconnects on its own.** Clients reconnect with backoff and resync on arrival.
- **No build framework.** The client is plain HTML, CSS and ES modules. Yjs is bundled locally by esbuild, so nothing loads from a CDN.

## Architecture

```
browser ──WebSocket (Yjs)──▶ Worker ──▶ CatalogDO  (one: the board list)
        ──HTTP /api/*──────▶        ──▶ BoardDO    (one per board)
                                    ──▶ JobDO      (one per card)
```

- **Worker** (`src/index.js`, `src/routes/`) validates ids, routes `/api/*` and WebSocket upgrades to the right Durable Object, and serves `app/` as static assets. It checks that a board or card exists before serving its page, and returns `404.html` otherwise.
- **YjsRoom** (`src/durable-objects/yjs-room.js`) is the shared base. It owns one `Y.Doc`, accepts [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), sends each new client the full state, and persists the encoded state in Durable Object storage.
- **CatalogDO** holds the board list (id, name, archived, created time). BoardDO keeps it in sync.
- **BoardDO** holds one board: its name, an ordered array of columns, and a map of card summaries (title, column, rank, assignee, due, labels, archived).
- **JobDO** holds one card document: a map of fields plus a `Y.Text` body and a labels array. A debounced observer diffs each change against the last snapshot, writes it to a `changelog` table in the object's SQLite storage, and pushes summary fields to BoardDO.

**Who writes what.** The catalog and board sockets are read-only: the server drops anything a client sends on them. Board and column changes, card creation, moves, archive and delete all go over HTTP, and the owning Durable Object applies them so every subscriber sees the result. The card socket is writable for its fields and body. The server reverts protected keys (`id`, `boardId`, `columnId`) and clamps field lengths.

**Ordering.** Cards carry integer ranks spaced 1024 apart. A move takes the midpoint of its neighbours and renumbers the column when the gap runs out.

Each document has one Durable Object as its single-threaded authority, and Yjs merges concurrent edits, so there are no version numbers or 409s. The body merges per character; scalar fields are last-writer-wins.

### HTTP API

`:board` and `:card` are opaque ids (`board_<uuid>`, `card_<uuid>`). Errors are JSON `{ "error": "..." }` with a 4xx status.

| Route | Method | Does |
|---|---|---|
| `/api/catalog/ws` | GET (upgrade) | Board list Yjs room (read-only) |
| `/api/catalog/snapshot` | GET | Board list as JSON |
| `/api/boards` | POST `{name}` | Create a board with default columns |
| `/api/boards/:board` | PATCH `{name?, archived?}` | Rename or archive a board |
| `/api/boards/:board/ws` | GET (upgrade) | Board Yjs room (read-only) |
| `/api/boards/:board/snapshot` | GET | Board, columns and cards as JSON |
| `/api/boards/:board/columns` | POST `{name}` | Add a column |
| `/api/boards/:board/columns/order` | POST `{ids}` | Reorder columns |
| `/api/boards/:board/columns/:column` | PATCH `{name}` / DELETE | Rename, or delete an empty column |
| `/api/boards/:board/cards` | POST `{title, columnId?}` | Create a card (first column by default) |
| `/api/boards/:board/cards/:card/move` | POST `{columnId, beforeId?}` | Move a card before another, or to the end |
| `/api/boards/:board/cards/:card/archive` | POST `{archived}` | Archive or restore |
| `/api/boards/:board/cards/:card` | DELETE | Delete (tombstone) |
| `/api/boards/:board/cards/:card/ws` | GET (upgrade) | Card Yjs room |
| `/api/boards/:board/cards/:card/snapshot` | GET | Card as JSON |
| `/api/boards/:board/cards/:card/history?limit=&before=` | GET | Changelog, newest first (default 50, max 200; `before` is an entry id) |
| `/api/health` | GET | Health check |

### Pages

| Path | Page |
|---|---|
| `/` | Board list |
| `/b/:board` | Board |
| `/b/:board/c/:card` | Card |

## Running

```sh
npm ci
npx wrangler dev --local
```

Open http://localhost:8787. Wrangler runs `npm run build:client` first, which bundles Yjs into `app/js/vendor/`. Local Durable Object state lives in `.wrangler/`; delete it to start fresh.

Deploy to your own Cloudflare account with `npx wrangler deploy`.

**There is no authentication.** Anyone who can reach the URL can read and edit every board. Run it locally, or put it behind something like Cloudflare Access.

## Configuration

`wrangler.toml` defines the Worker, the `CATALOG_DO`, `BOARD_DO` and `JOB_DO` bindings with their SQLite migrations, and the `app/` asset directory. `run_worker_first` lets the Worker check page routes before assets are served. Limits and id formats live in `src/lib/constants.js`.

## Layout

```
src/
  index.js                  Worker entry, page routes
  routes/                   API routing (boards, cards, DO helpers)
  durable-objects/
    yjs-room.js             shared Yjs room base, tombstones
    catalog-do.js           board list
    board-do.js             board: columns, card summaries, ranks
    job-do.js               card document, changelog, board sync
  lib/                      constants, ranks, field clamps, JSON, snapshots, diffs
app/
  index.html  board.html  card.html  404.html  css/app.css
  js/
    yjs-sync.js             client room connection
    boards.js  board.js  card.js  card-model.js  config.js
    vendor/                 bundled Yjs (generated)
```

## License

[MIT](LICENSE) © 2026 Jacob Murdock
