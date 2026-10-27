/** Minimal Yjs ↔ WebSocket sync matching the Durable Object room protocol.
 * Writable rooms (card documents) push local updates. Board and catalog rooms
 * are read-only on the socket, so this client only applies server updates.
 */

import * as Y from "./vendor/yjs.js";

const MAX_RECONNECT_MS = 15000;

export function setStatus(el, state, label) {
  if (!el) return;
  el.dataset.state = state;
  el.textContent = label;
}

/**
 * `stillThere` runs before each reconnect. Return false when the board or card
 * is gone (so a 404 upgrade does not retry forever). Throw to keep retrying,
 * which is what a network failure looks like while offline.
 * `onMissing` runs once when that check fails. `ready` resolves to null if the
 * room gives up before the first sync.
 */
export function connectYjsRoom(url, { writable = false, onClose, stillThere, onMissing } = {}) {
  const doc = new Y.Doc();

  let ws = null;
  let synced = false;
  let attempts = 0;
  let stopped = false;
  let manualClose = false;
  let statusEl = null;
  let reconnectTimer = null;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  if (writable) {
    doc.on("update", (update, origin) => {
      if (origin === "remote") return;
      if (ws?.readyState === WebSocket.OPEN) ws.send(update);
    });
  }

  function connect() {
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      attempts = 0;
      setStatus(statusEl, "connecting", synced ? "Reconnecting…" : "Connecting…");
      if (!writable) return;
      // Send our state so the server merges any edits made while offline.
      const state = Y.encodeStateAsUpdate(doc);
      if (state.length) ws.send(state);
    });

    ws.addEventListener("message", (event) => {
      Y.applyUpdate(doc, new Uint8Array(event.data), "remote");
      setStatus(statusEl, "connected", "Live");
      if (!synced) {
        synced = true;
        resolveReady(doc);
      }
    });

    ws.addEventListener("close", (event) => {
      if (stopped || manualClose) return;
      void considerReconnect(event);
    });

    ws.addEventListener("error", () => {
      // Let the close handler drive reconnection.
      ws.close();
    });
  }

  async function considerReconnect(event) {
    if (stopped || manualClose) return;
    if (event?.code === 4403) {
      stop();
      setStatus(statusEl, "error", "Access removed");
      onClose?.(event);
      return;
    }
    if (onClose?.(event) === true) {
      stop();
      return;
    }

    setStatus(statusEl, "error", "Reconnecting…");
    if (stillThere) {
      try {
        if ((await stillThere()) === false) {
          giveUp();
          return;
        }
      } catch {
        // Offline, or the check itself failed. The resource may still exist.
      }
    }
    if (stopped || manualClose) return;

    const delay = Math.min(1000 * 2 ** attempts, MAX_RECONNECT_MS);
    attempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function stop() {
    stopped = true;
    manualClose = true;
    clearTimeout(reconnectTimer);
    if (!synced) resolveReady(null);
  }

  function giveUp() {
    stop();
    if (onMissing) onMissing();
    else setStatus(statusEl, "error", "Not found");
  }

  function bindStatus(el) {
    statusEl = el;
  }

  function disconnect() {
    stop();
    ws?.close();
  }

  connect();

  return { doc, ready, bindStatus, disconnect };
}
