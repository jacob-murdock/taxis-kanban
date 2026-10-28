#!/usr/bin/env node
/**
 * End-to-end smoke against a temporary `wrangler dev`.
 *
 *   node scripts/smoke.mjs [port]
 *
 * Signs in through the console-logged magic link, then checks boards, card
 * sync, the read-only board socket, history, and tombstones. Uses its own
 * persist directory and env file, so it does not read `.dev.vars` or `.wrangler/`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachRoom, sendStep1, sendUpdate, waitFor } from "../test/helpers/yjs-room.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] ? Number(process.argv[2]) : 8799;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: node scripts/smoke.mjs [port]");
  process.exit(1);
}

const origin = `http://127.0.0.1:${port}`;
const email = "smoke@example.com";
let log = "";
let child = null;
let stopped = false;
let persistDir = null;

function stop() {
  if (stopped || !child?.pid) return;
  stopped = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(label, actual, expected) {
  const same =
    actual === expected ||
    (typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (!same) {
    throw new Error(
      `${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
    );
  }
  console.log(`ok ${label}`);
}

async function request(pathname, { method = "GET", cookie, body } = {}) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text, setCookie: response.headers.getSetCookie?.() ?? [] };
}

function cookieFrom(setCookie) {
  for (const header of setCookie) {
    const pair = header.split(";")[0];
    const idx = pair.indexOf("=");
    if (pair.slice(0, idx).trim() === "tk_session") return pair.trim();
  }
  return null;
}

async function connect(url, cookie, { writable = false } = {}) {
  const ws = new WebSocket(url, {
    headers: { Origin: origin, Cookie: cookie },
  });
  ws.binaryType = "arraybuffer";
  const room = attachRoom(ws, { writable });
  let opened = false;
  const failed = new Promise((_, reject) => {
    ws.addEventListener("error", () => {
      if (!opened) reject(new Error(`websocket error ${url}`));
    });
    ws.addEventListener("close", (event) => {
      if (!opened) reject(new Error(`websocket closed before open (${event.code}) ${url}`));
    });
  });
  ws.addEventListener("open", () => {
    opened = true;
    room.start();
  });
  try {
    await Promise.race([room.synced, failed]);
  } finally {
    failed.catch(() => {});
    room.synced.catch(() => {});
  }
  return { ws, room };
}

async function main() {
  persistDir = await mkdtemp(path.join(tmpdir(), "taxis-smoke-"));
  const envFile = path.join(persistDir, "smoke.env");
  await writeFile(envFile, "SESSION_SECRET=smoke-session-secret\n");

  const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
  child = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1),
      "--persist-to",
      persistDir,
      "--env-file",
      envFile,
      "--no-show-interactive-dev-session",
    ],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
  });
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  const deadline = Date.now() + 90_000;
  let healthy = null;
  while (Date.now() < deadline) {
    if (exitCode != null) break;
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) {
        healthy = await response.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  if (!healthy) {
    throw new Error(`wrangler did not become healthy (exit ${exitCode})`);
  }
  check("health", healthy, { ok: true, service: "taxis-kanban" });

  check("home", (await request("/")).status, 200);
  check("unknown api", (await request("/api/nope")).status, 404);
  const missing =
    "/api/boards/board_00000000-0000-4000-8000-000000000001/snapshot";
  check("signed-out snapshot", (await request(missing)).status, 401);

  const requested = await request("/api/auth/request", {
    method: "POST",
    body: { email },
  });
  check("magic link request", requested.status, 200);

  let token = null;
  const tokenDeadline = Date.now() + 15_000;
  while (Date.now() < tokenDeadline) {
    const match = log.match(/token=([0-9a-f]{64})/i);
    if (match) {
      token = match[1];
      break;
    }
    await delay(100);
  }
  if (!token) throw new Error("magic link was not logged");

  const consumed = await request("/api/auth/consume", {
    method: "POST",
    body: { token },
  });
  check("consume link", consumed.status, 200);
  const cookie = cookieFrom(consumed.setCookie);
  if (!cookie) throw new Error("session cookie missing");
  console.log("ok session cookie");

  const created = await request("/api/boards", {
    method: "POST",
    cookie,
    body: { name: "Smoke" },
  });
  check("create board", created.status, 201);
  const boardId = created.json.id;
  const snapshot = await request(`/api/boards/${boardId}/snapshot`, { cookie });
  check("default columns", snapshot.json.columns.map((column) => column.name), [
    "To do",
    "Doing",
    "Done",
  ]);
  const [todo, doing] = snapshot.json.columns;

  const column = await request(`/api/boards/${boardId}/columns`, {
    method: "POST",
    cookie,
    body: { name: "Later" },
  });
  check("add column", column.status, 201);

  const first = await request(`/api/boards/${boardId}/cards`, {
    method: "POST",
    cookie,
    body: { title: "One", columnId: todo.id },
  });
  const second = await request(`/api/boards/${boardId}/cards`, {
    method: "POST",
    cookie,
    body: { title: "Two", columnId: todo.id },
  });
  check("create cards", [first.status, second.status], [201, 201]);

  const moved = await request(`/api/boards/${boardId}/cards/${second.json.id}/move`, {
    method: "POST",
    cookie,
    body: { columnId: doing.id },
  });
  check("move card", moved.status, 200);
  const placed = await request(`/api/boards/${boardId}/snapshot`, { cookie });
  check("moved column", placed.json.cards[second.json.id].columnId, doing.id);

  const cardWs = `ws://127.0.0.1:${port}/api/boards/${boardId}/cards/${first.json.id}/ws`;
  const a = await connect(cardWs, cookie, { writable: true });
  const b = await connect(cardWs, cookie, { writable: true });
  a.room.doc.getText("body").insert(0, "alpha");
  b.room.doc.getText("body").insert(0, "beta");
  await waitFor(() => {
    const left = a.room.doc.getText("body").toString();
    const right = b.room.doc.getText("body").toString();
    return left === right && left.includes("alpha") && left.includes("beta");
  }, "card sockets did not converge");
  console.log("ok card sockets converge");
  const cardSnap = await request(`/api/boards/${boardId}/cards/${first.json.id}/snapshot`, {
    cookie,
  });
  check("card snapshot body", cardSnap.json.body, a.room.doc.getText("body").toString());
  a.ws.close();
  b.ws.close();

  const boardWs = `ws://127.0.0.1:${port}/api/boards/${boardId}/ws`;
  const boardRoom = await connect(boardWs, cookie);
  const originalName = boardRoom.room.doc.getMap("meta").get("name");
  let update;
  const onUpdate = (next, origin) => {
    if (origin !== "remote") update = next;
  };
  boardRoom.room.doc.on("update", onUpdate);
  boardRoom.room.doc.getMap("meta").set("name", "forged-name");
  boardRoom.room.doc.off("update", onUpdate);
  if (!update) throw new Error("board edit produced no update");
  const replied = boardRoom.room.waitForStep1();
  sendUpdate(boardRoom.ws, update);
  sendStep1(boardRoom.ws, boardRoom.room.doc);
  await replied;
  const afterForge = await request(`/api/boards/${boardId}/snapshot`, { cookie });
  check("board socket stayed read-only", afterForge.json.name, originalName);
  boardRoom.ws.close();

  const archived = await request(`/api/boards/${boardId}/cards/${first.json.id}/archive`, {
    method: "POST",
    cookie,
    body: { archived: true },
  });
  check("archive", archived.status, 200);
  const historyPath = `/api/boards/${boardId}/cards/${first.json.id}/history`;
  const history = await request(`${historyPath}?limit=2`, { cookie });
  check("history page", history.status, 200);
  if (!Array.isArray(history.json.entries) || history.json.entries.length < 2) {
    throw new Error(`expected a history page, got ${JSON.stringify(history.json)}`);
  }
  const cursor = history.json.entries[history.json.entries.length - 1].id;
  const older = await request(`${historyPath}?limit=2&before=${cursor}`, { cookie });
  const olderIds = (older.json.entries ?? []).map((entry) => entry.id);
  if (older.status !== 200 || olderIds.length === 0 || olderIds.some((id) => id >= cursor)) {
    throw new Error(`history cursor failed: ${JSON.stringify(older.json)}`);
  }
  console.log("ok history cursor");
  check("bad history limit", (await request(`${historyPath}?limit=abc`, { cookie })).status, 400);

  const deleted = await request(`/api/boards/${boardId}/cards/${first.json.id}`, {
    method: "DELETE",
    cookie,
  });
  check("delete card", deleted.status, 200);
  const gone = `/api/boards/${boardId}/cards/${first.json.id}/snapshot`;
  check("tombstone", (await request(gone, { cookie })).status, 404);
  check("tombstone holds", (await request(gone, { cookie })).status, 404);
  const rest = await request(`/api/boards/${boardId}/snapshot`, { cookie });
  check("card left the board", rest.json.cards[first.json.id], undefined);
  check("other card remains", rest.json.cards[second.json.id].title, "Two");
}

try {
  await main();
  console.log("smoke passed");
} catch (err) {
  console.error(err?.stack || err);
  console.error("--- wrangler log (tail) ---");
  console.error(log.slice(-4000));
  process.exitCode = 1;
} finally {
  stop();
  await delay(300);
  if (persistDir) await rm(persistDir, { recursive: true, force: true });
}
