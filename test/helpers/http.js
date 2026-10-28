/**
 * Signed-in HTTP and WebSocket calls against the Worker under test.
 * Session cookies are minted the same way the Worker verifies them.
 */

import { env, exports } from "cloudflare:workers";
import { signSession } from "../../src/lib/auth.js";
import { SESSION_COOKIE, SESSION_TTL_SEC } from "../../src/lib/constants.js";
import { attachRoom } from "./yjs-room.js";

export const ORIGIN = "http://example.com";

export async function signIn(email) {
  const auth = env.AUTH_DO.get(env.AUTH_DO.idFromName("auth"));
  const response = await auth.fetch(
    new Request("https://do.internal/session/bump", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`session bump failed (${response.status}): ${detail}`);
  }
  const { gen } = await response.json();
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const value = await signSession(env.SESSION_SECRET, email, gen, exp);
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

export async function api(path, { method = "GET", cookie, body } = {}) {
  const headers = new Headers({ Origin: ORIGIN });
  if (cookie) headers.set("Cookie", cookie);
  let payload;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: payload }),
  );
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

/** Open a board or card socket and finish the sync handshake. */
export async function openRoom(path, cookie, { writable = false } = {}) {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Origin: ORIGIN,
      Cookie: cookie,
    },
  });
  const ws = response.webSocket;
  if (!ws) {
    const text = await response.text();
    throw new Error(`WebSocket upgrade failed (${response.status}): ${text}`);
  }
  if ("binaryType" in ws) ws.binaryType = "arraybuffer";
  const room = attachRoom(ws, { writable });
  ws.accept();
  room.start();
  await room.synced;
  return { ws, doc: room.doc, waitForStep1: room.waitForStep1 };
}

export function closeRoom(ws) {
  try {
    ws.close(1000, "done");
  } catch {
    /* already closing */
  }
}
