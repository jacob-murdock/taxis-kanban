/** Minimal Yjs ↔ WebSocket sync matching the Durable Object room protocol.
 * Uses y-protocols sync step 1/2 so reconnects move a state-vector diff, not
 * a full snapshot, plus awareness for who's in the room. Writable rooms (card
 * documents) push local document updates. Board and catalog rooms are
 * read-only on the socket for document edits.
 */

import { openDocStore } from "./doc-store.js";
import * as Y from "./vendor/yjs.js";
import {
  Awareness,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  applyAwarenessUpdate,
  decodeRoomMessage,
  encodeAwarenessMessage,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  removeAwarenessStates,
} from "./vendor/ws-sync.js";

const MAX_RECONNECT_MS = 15000;
/** Don't let a stuck IndexedDB open keep the socket from starting. */
const HYDRATE_WAIT_MS = 1500;

export function setStatus(el, state, label) {
  if (!el) return;
  // Same text again would retrigger a status live region on every sync frame.
  if (el.dataset.state === state && el.textContent === label) return;
  el.dataset.state = state;
  el.textContent = label;
}

/**
 * `stillThere` runs before each reconnect. Return false when the board or card
 * is gone (so a 404 upgrade does not retry forever). Throw to keep retrying,
 * which is what a network failure looks like while offline.
 * `onMissing` runs once when that check fails. `ready` resolves to null if the
 * room gives up before the first sync.
 * `user` is `{ email }` published into awareness after the first sync.
 * `docKey` hydrates the doc from IndexedDB before the socket opens so a
 * reload does not drop unsynced local edits. If that read stalls, the socket
 * starts anyway and a second step 1 is sent once the saved updates are in.
 */
export function connectYjsRoom(
  url,
  { writable = false, user = null, onClose, stillThere, onMissing, docKey } = {},
) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);

  let ws = null;
  let synced = false;
  let attempts = 0;
  let stopped = false;
  let manualClose = false;
  let statusEl = null;
  let reconnectTimer = null;
  let store = null;
  let hasLocalData = false;
  let started = false;
  let hydrateTimer = null;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  if (writable) {
    doc.on("update", (update, origin) => {
      if (origin === "remote" || origin === "idb") return;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encodeSyncUpdate(update));
    });
  }

  awareness.on("update", ({ added, updated, removed }, origin) => {
    if (origin !== "local") {
      // A peer just appeared — reply with our own state so they see us too.
      if (origin === "remote" && added.length && ws?.readyState === WebSocket.OPEN) {
        ws.send(encodeAwarenessMessage(awareness, [awareness.clientID]));
      }
      return;
    }
    const changed = added.concat(updated, removed);
    if (!changed.length || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(encodeAwarenessMessage(awareness, changed));
  });

  function publishUser() {
    if (!user?.email) return;
    // The room overwrites this with the session email before any peer sees it.
    awareness.setLocalStateField("user", { email: user.email });
  }

  function connect() {
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      attempts = 0;
      setStatus(statusEl, "connecting", synced ? "Reconnecting…" : "Connecting…");
      // Client-server sync: we ask with our state vector; the server replies
      // with only the missing update, then its own step 1.
      ws.send(encodeSyncStep1(doc));
    });

    ws.addEventListener("message", (event) => {
      const parsed = decodeRoomMessage(event.data);
      if (!parsed) return;

      if (parsed.type === "awareness") {
        applyAwarenessUpdate(awareness, parsed.payload, "remote");
        return;
      }

      if (parsed.syncType === SYNC_STEP1) {
        // Server's step 1 — reply with whatever it is missing (usually empty).
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(encodeSyncStep2(doc, parsed.payload));
        }
        return;
      }

      if (parsed.syncType === SYNC_STEP2 || parsed.syncType === SYNC_UPDATE) {
        Y.applyUpdate(doc, parsed.payload, "remote");
        setStatus(statusEl, "connected", "Live");
        if (parsed.syncType === SYNC_STEP2 && !synced) {
          synced = true;
          publishUser();
          resolveReady(doc);
        } else if (parsed.syncType === SYNC_STEP2) {
          // Reconnect: re-announce presence after the diff lands.
          publishUser();
        }
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
    clearTimeout(hydrateTimer);
    clearTimeout(reconnectTimer);
    store?.destroy();
    store = null;
    try {
      removeAwarenessStates(awareness, [awareness.clientID], "local");
    } catch {
      /* already destroyed */
    }
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

  const loaded = (async () => {
    if (!docKey) return;
    try {
      const opened = openDocStore(doc, docKey);
      store = opened;
      await opened.whenReady;
      if (stopped) {
        opened.destroy();
        return;
      }
      hasLocalData = opened.hasLocalData;
    } catch {
      /* IndexedDB failed; live sync still works. */
    }
  })();

  function begin() {
    if (stopped || started) return;
    started = true;
    connect();
  }

  // The open handler sends step 1. If that already happened on a partial doc,
  // ask again so the saved edits are part of the state vector.
  function resync() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(encodeSyncStep1(doc));
  }

  if (docKey) {
    hydrateTimer = setTimeout(begin, HYDRATE_WAIT_MS);
    void loaded.then(() => {
      clearTimeout(hydrateTimer);
      if (stopped) return;
      if (started) resync();
      else begin();
    });
  } else {
    begin();
  }

  return {
    doc,
    awareness,
    ready,
    loaded,
    get hasLocalData() {
      return hasLocalData;
    },
    bindStatus,
    disconnect,
  };
}
