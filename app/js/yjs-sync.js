/** Minimal Yjs ↔ WebSocket sync matching the Durable Object room protocol. */

import * as Y from "./vendor/yjs.js";

const MAX_RECONNECT_MS = 15000;

export function connectYjsRoom(url) {
  const doc = new Y.Doc();

  let ws = null;
  let synced = false;
  let attempts = 0;
  let manualClose = false;
  let statusEl = null;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function connect() {
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      attempts = 0;
      setStatus("connecting", synced ? "Reconnecting…" : "Connecting…");
      // Send our state so the server merges any edits made while offline.
      const state = Y.encodeStateAsUpdate(doc);
      if (state.length) ws.send(state);
    });

    ws.addEventListener("message", (event) => {
      Y.applyUpdate(doc, new Uint8Array(event.data), "remote");
      setStatus("connected", "Live");
      if (!synced) {
        synced = true;
        resolveReady(doc);
      }
    });

    ws.addEventListener("close", () => {
      if (manualClose) return;
      setStatus("error", "Reconnecting…");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // Let the close handler drive reconnection.
      ws.close();
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** attempts, MAX_RECONNECT_MS);
    attempts += 1;
    setTimeout(connect, delay);
  }

  doc.on("update", (update, origin) => {
    if (origin !== "remote" && ws?.readyState === WebSocket.OPEN) {
      ws.send(update);
    }
  });

  function bindStatus(el) {
    statusEl = el;
  }

  function setStatus(state, label) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    if (label) statusEl.textContent = label;
  }

  function disconnect() {
    manualClose = true;
    ws?.close();
  }

  connect();

  return { doc, ready, bindStatus, disconnect };
}

/** Board cards may be stored as objects; normalize either shape. */
export function normalizeCard(entry) {
  if (Array.isArray(entry)) return entry[0] ?? null;
  return entry ?? null;
}
