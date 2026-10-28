/**
 * Yjs room client shared by the Workers tests and the smoke script.
 * Speaks the same step-1/2 frames as the Durable Object.
 */

import * as Y from "yjs";
import {
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  decodeRoomMessage,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from "../../src/lib/ws-sync.js";

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data?.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  return null;
}

export function bytes(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function sendUpdate(ws, update) {
  ws.send(bytes(encodeSyncUpdate(update)));
}

export function sendStep1(ws, doc) {
  ws.send(bytes(encodeSyncStep1(doc)));
}

/**
 * Attach sync handlers to an already constructed WebSocket.
 * Call `start()` once the socket is open (Node) or accepted (Workers).
 * `writable` pushes local document updates, matching the card page.
 */
export function attachRoom(ws, { writable = false } = {}) {
  const doc = new Y.Doc();
  const step1Waiters = [];
  let synced = false;
  let resolveSynced;
  let rejectSynced;
  const syncedPromise = new Promise((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
  });
  const timer = setTimeout(() => rejectSynced(new Error("room sync timed out")), 8000);

  let inbox = Promise.resolve();
  ws.addEventListener("message", (event) => {
    inbox = inbox.then(() => onMessage(event)).catch((err) => {
      if (!synced) rejectSynced(err);
    });
  });

  async function onMessage(event) {
    const data = await toBytes(event.data);
    if (!data) return;
    const parsed = decodeRoomMessage(data);
    if (!parsed || parsed.type !== "sync") return;
    if (parsed.syncType === SYNC_STEP2 || parsed.syncType === SYNC_UPDATE) {
      Y.applyUpdate(doc, parsed.payload, "remote");
      return;
    }
    if (parsed.syncType !== SYNC_STEP1) return;
    ws.send(bytes(encodeSyncStep2(doc, parsed.payload)));
    const waiter = step1Waiters.shift();
    if (waiter) waiter();
    if (!synced) {
      synced = true;
      clearTimeout(timer);
      resolveSynced();
    }
  }

  if (writable) {
    doc.on("update", (update, origin) => {
      if (origin === "remote") return;
      if (ws.readyState === WebSocket.OPEN) sendUpdate(ws, update);
    });
  }

  return {
    doc,
    synced: syncedPromise,
    start() {
      sendStep1(ws, doc);
    },
    /** Resolves on the next server SyncStep1, so a prior frame has been handled. */
    waitForStep1() {
      return new Promise((resolve, reject) => {
        const waitTimer = setTimeout(() => reject(new Error("sync step 1 timed out")), 5000);
        step1Waiters.push(() => {
          clearTimeout(waitTimer);
          resolve();
        });
      });
    },
  };
}

export async function waitFor(pred, label, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}
