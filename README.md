# Taxis Kanban

**A realtime collaborative kanban board on Cloudflare Workers, Durable Objects and Yjs.**

Everyone on the board sees cards move as they move. Open a job and several people can edit its fields and markdown notes at once. Edits merge on their own: there's no save button and no conflict dialog. Each job keeps a field-level history of what changed.

---

## Features

- **Live board.** Cards sit in lifecycle columns (Lead → Scoped → Active → Review → Done → Invoiced → Paid). Drag a card or pick a status, and every open board updates.
- **Live job pages.** Title, status, client, amount and due date are shared fields. The notes body is a shared text document that merges character by character, so two people typing in different places don't overwrite each other.
- **Change history.** Every field edit is recorded with its old and new value, and shown on the job page.
- **Reconnects on its own.** Clients reconnect with backoff and push any edits made while disconnected, which merge on arrival.
- **No build framework.** The client is plain HTML, CSS and ES modules. Yjs is bundled locally by esbuild, so nothing loads from a CDN.

## Architecture

```
browser ──WebSocket (Yjs updates)──▶ Worker ──▶ BoardDO   (one per workspace)
        ──HTTP /api/*──────────────▶        ──▶ JobDO     (one per job)
```

- **Worker** (`src/index.js`) routes `/api/*` requests and WebSocket upgrades to the right Durable Object and serves `app/` as static assets.
- **YjsRoom** (`src/durable-objects/yjs-room.js`) is the shared base for both objects. It owns one `Y.Doc`, accepts [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) so idle connections cost nothing, sends each new client the full state, relays binary Yjs updates to the other peers, and persists the encoded state in Durable Object storage.
- **BoardDO** holds the board as a `Y.Array` of card summaries (id, title, client, due, status).
- **JobDO** holds one job as a `Y.Map` of fields plus a `Y.Text` body. A debounced observer diffs each change against the last snapshot, writes it to a `changelog` table in the object's SQLite storage, and pushes summary fields (title, status, client, due) to BoardDO so the card stays current. An alarm stores a materialized JSON snapshot.

Because each document has one Durable Object as its single-threaded authority and Yjs merges concurrent edits, there are no version numbers or 409s. Text merges per character; scalar fields are last-writer-wins.

Money is stored as integer minor units plus a currency (`320000` = $3,200.00 USD). Job ids are opaque and stable, separate from the human-readable slug.

### HTTP API

| Route | Method | Does |
|---|---|---|
| `/api/board/ws` | GET (upgrade) | Board Yjs room |
| `/api/board/snapshot` | GET | Board cards as JSON |
| `/api/jobs` | POST `{title}` | Create a job and its card |
| `/api/jobs/:id/ws` | GET (upgrade) | Job Yjs room |
| `/api/jobs/:id/snapshot` | GET | Job as JSON |
| `/api/jobs/:id/history?limit=` | GET | Changelog, newest first (max 200) |
| `/api/jobs/:id/status` | POST `{status}` | Set status |
| `/api/health` | GET | Health check |

## Running

```sh
npm i && npx wrangler dev
```

Open http://localhost:8787. Wrangler runs `npm run build:client` first, which bundles Yjs into `app/js/vendor/`. Local Durable Object state lives in `.wrangler/`.

Deploy to your own Cloudflare account with `npx wrangler deploy`. To serve it on your own domain, add a `[[routes]]` entry to `wrangler.toml`.

There is no authentication: anyone who can reach the URL can edit every board. Run it locally or behind something like Cloudflare Access.

## Configuration

`wrangler.toml` defines the Worker name, the `BOARD_DO` and `JOB_DO` bindings with their SQLite migration, and the `app/` asset directory. The lifecycle statuses live in `src/lib/constants.js` and `app/js/constants.js`.

## Layout

```
src/
  index.js                  Worker router
  durable-objects/
    yjs-room.js             shared Yjs room base
    board-do.js             board document
    job-do.js               job document, changelog, board sync
  lib/
    materialize.js          Y.Doc → JSON
    changelog.js            snapshot diff
    constants.js
app/
  index.html  job.html  css/app.css
  js/
    yjs-sync.js             client room connection
    board.js  job.js  job-model.js  config.js  constants.js
    vendor/                 bundled Yjs (generated)
```

## License

[MIT](LICENSE) © 2026 Jacob Murdock
