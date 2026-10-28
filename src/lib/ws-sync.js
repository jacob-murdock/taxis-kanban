/**
 * y-protocols sync + awareness frames over the card/board/catalog WebSocket.
 * Top-level type 0 = sync, 1 = awareness (matches y-websocket).
 */

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  AWARENESS_CLOCK_MAX,
  AWARENESS_FRAME_MAX_BYTES,
  AWARENESS_UPDATE_MAX_BYTES,
  EMAIL_MAX,
} from "./constants.js";

/**
 * Field names the card page publishes while focused.
 * Keep in step with `trackFocus` in app/js/card.js and the footer allowlist.
 */
export const PRESENCE_EDITING_FIELDS = new Set([
  "title",
  "column",
  "assignee",
  "due",
  "body",
  "label",
]);

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export const SYNC_STEP1 = syncProtocol.messageYjsSyncStep1;
export const SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;
export const SYNC_UPDATE = syncProtocol.messageYjsUpdate;

export { Awareness, applyAwarenessUpdate, removeAwarenessStates };

/**
 * Updates integrated while `fn` runs, for origin `"remote"` only.
 * `encodeStateAsUpdate` always writes the whole delete set, so after any
 * deletion a no-op diff is longer than an empty update. The `"update"` event
 * fires only when this transaction actually changed the document.
 */
export function captureRemoteUpdates(doc, fn) {
  const parts = [];
  const capture = (update, origin) => {
    if (origin === "remote") parts.push(update);
  };
  doc.on("update", capture);
  try {
    fn();
  } finally {
    doc.off("update", capture);
  }
  return parts;
}

export function encodeSyncStep1(doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** `stateVector` is the remote peer's SV from SyncStep1. */
export function encodeSyncStep2(doc, stateVector) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessMessage(awareness, clientIds) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clientIds));
  return encoding.toUint8Array(encoder);
}

/**
 * Peel a room frame. Returns null when the envelope is unknown.
 * Sync: `{ type: "sync", syncType, payload }`
 * Awareness: `{ type: "awareness", payload }`
 */
export function decodeRoomMessage(data) {
  try {
    const decoder = decoding.createDecoder(data instanceof Uint8Array ? data : new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const syncType = decoding.readVarUint(decoder);
      if (syncType !== SYNC_STEP1 && syncType !== SYNC_STEP2 && syncType !== SYNC_UPDATE) {
        return null;
      }
      return { type: "sync", syncType, payload: decoding.readVarUint8Array(decoder) };
    }
    if (messageType === MESSAGE_AWARENESS) {
      return { type: "awareness", payload: decoding.readVarUint8Array(decoder) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Peek at a socket frame without decoding it.
 * `"awareness"` is small enough to parse; `"oversize"` must be dropped first;
 * null means some other (or empty) frame.
 * @param {ArrayBuffer | Uint8Array | string | null | undefined} message
 */
export function classifyAwarenessFrame(message) {
  if (message == null || typeof message === "string") return null;
  const size = message.byteLength;
  if (typeof size !== "number" || size < 1) return null;
  let first;
  if (message instanceof Uint8Array) first = message[0];
  else if (message instanceof ArrayBuffer) first = new Uint8Array(message, 0, 1)[0];
  else return null;
  if (first !== MESSAGE_AWARENESS) return null;
  if (size > AWARENESS_FRAME_MAX_BYTES) return "oversize";
  return "awareness";
}

/**
 * Rebuild one awareness update so it can only speak for `clientId` as `email`.
 * Returns null when the frame is not a single well-formed entry.
 * A null state is kept (this socket leaving) but still under `clientId`.
 * @param {Uint8Array} payload inner awareness update (not the room envelope)
 * @param {{ clientId: number, email: string }} identity
 * @returns {Uint8Array | null}
 */
export function sanitizeAwarenessUpdate(payload, { clientId, email }) {
  if (!(payload instanceof Uint8Array) || payload.byteLength > AWARENESS_UPDATE_MAX_BYTES) {
    return null;
  }
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) return null;
  if (typeof email !== "string" || !email || email.length > EMAIL_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(email)) return null;

  try {
    const decoder = decoding.createDecoder(payload);
    const len = decoding.readVarUint(decoder);
    // One socket, one presence. Extra client ids are how a peer is cleared or flooded.
    if (len !== 1) return null;
    decoding.readVarUint(decoder); // claimed id is ignored
    const clock = decoding.readVarUint(decoder);
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > AWARENESS_CLOCK_MAX) return null;
    const state = JSON.parse(decoding.readVarString(decoder));
    if (decoding.hasContent(decoder)) return null;

    let clean = null;
    if (state !== null) {
      if (typeof state !== "object" || Array.isArray(state)) return null;
      clean = { user: { email } };
      const editing = state.editing;
      if (typeof editing === "string" && PRESENCE_EDITING_FIELDS.has(editing)) {
        clean.editing = editing;
      }
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(clean));
    return encoding.toUint8Array(encoder);
  } catch {
    return null;
  }
}

/**
 * Awareness update that removes one client, wrapped as a room frame.
 * The clock is the maximum we accept, so this wins over any frame that
 * socket already relayed. An equal clock with a null state also removes it.
 */
export function encodeAwarenessLeave(clientId) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, AWARENESS_CLOCK_MAX);
  encoding.writeVarString(encoder, JSON.stringify(null));
  return encodeAwarenessFrame(encoding.toUint8Array(encoder));
}

/** Wrap an awareness update in a room frame (message type 1). */
export function encodeAwarenessFrame(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/**
 * Fixed window counter. When the window has elapsed, the next call starts a new one.
 * Over the limit, `count` is left unchanged so the caller can skip persisting it.
 */
export function bumpRateWindow(now, start, count, limit, windowMs) {
  const fresh = !Number.isFinite(start) || now - start >= windowMs;
  const windowStart = fresh ? now : start;
  const used = fresh ? 0 : Number.isFinite(count) ? count : 0;
  if (used >= limit) return { windowStart, count: used, allowed: false };
  return { windowStart, count: used + 1, allowed: true };
}

/**
 * `entries` is room order. Only the first `limit` sockets for `email` may publish.
 * A socket missing from the list still counts against that budget (its peers do).
 * @param {Array<{ email?: string, clientId?: number }>} entries
 */
export function presencePublishAllowed(entries, email, clientId, limit) {
  if (typeof email !== "string" || !email) return false;
  if (!Number.isInteger(clientId)) return false;
  let before = 0;
  for (const entry of entries) {
    if (entry?.email !== email) continue;
    if (entry.clientId === clientId) return before < limit;
    before += 1;
  }
  return before < limit;
}

/** Pick a presence client id that no open socket already holds. */
export function allocateAwarenessClientId(used) {
  const taken = used instanceof Set ? used : new Set(used);
  const buf = new Uint32Array(1);
  for (let i = 0; i < 8; i++) {
    crypto.getRandomValues(buf);
    if (!taken.has(buf[0])) return buf[0];
  }
  let id = 1;
  while (taken.has(id)) id += 1;
  return id;
}
