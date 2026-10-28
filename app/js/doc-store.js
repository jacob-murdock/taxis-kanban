/** Per-account IndexedDB log of Yjs updates for one card document.
 * Hydrate before the socket handshake so unsynced local edits are in the doc
 * when sync step 1 goes out. Remote updates are stored too, so a reload can
 * paint the last known card instead of only the offline tail.
 *
 * Each edit starts its IndexedDB transaction before the update handler returns.
 * Waiting on a lock here drops the tail of a burst if the page reloads first.
 */

import * as Y from "./vendor/yjs.js";
import { bumpSessionGen, forgetSession, sessionGen } from "./local-session.js";

const DB_NAME = "taxis-yjs";
const DB_VERSION = 1;
const STORE = "updates";
const DOC_INDEX = "doc";
const COMPACT_EVERY = 50;

const SEP = "\0";

/** Email, boardId, and cardId joined by NUL. Email cannot contain NUL. */
export function cardDocKey(email, boardId, cardId) {
  return `${email}${SEP}${boardId}${SEP}${cardId}`;
}

function userRange(email) {
  // Every doc key for this email sorts in [email + NUL, email + U+0001).
  return IDBKeyRange.bound(`${email}${SEP}`, `${email}\u0001`, false, true);
}

let dbPromise = null;
let dbInstance = null;

function openDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) return;
      const store = db.createObjectStore(STORE, { autoIncrement: true });
      store.createIndex(DOC_INDEX, "doc", { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      dbInstance = db;
      db.onversionchange = () => {
        db.close();
      };
      db.onclose = () => {
        if (dbInstance === db) dbInstance = null;
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => {
      event?.preventDefault?.();
      reject(tx.error || new Error("IndexedDB transaction failed"));
    };
    tx.onabort = (event) => {
      event?.preventDefault?.();
      reject(tx.error || new Error("IndexedDB transaction aborted"));
    };
  });
}

function copyBytes(update) {
  return new Uint8Array(update);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/** Issue getAll/getAllKeys together so the transaction stays alive. */
async function readDocRows(docKey) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index(DOC_INDEX);
  const range = IDBKeyRange.only(docKey);
  const valuesReq = index.getAll(range);
  const keysReq = index.getAllKeys(range);
  await txDone(tx);
  const values = valuesReq.result || [];
  const keys = keysReq.result || [];
  return keys.flatMap((key, i) => {
    const bytes = asBytes(values[i]?.bytes);
    if (!bytes?.byteLength) return [];
    return [{ key, bytes: copyBytes(bytes) }];
  });
}

/** The add is synchronous. A reload keeps IndexedDB transactions that have already started. */
function addUpdate(db, docKey, bytes) {
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).add({ doc: docKey, bytes });
  return txDone(tx);
}

async function writeUpdate(docKey, bytes, ended) {
  try {
    const db = dbInstance || (await openDb());
    if (ended()) return;
    await addUpdate(db, docKey, bytes);
  } catch {
    /* persistence is best-effort */
  }
}

/** Replace `rows` with one merged update. Keys appended after the read stay. */
async function compactDoc(docKey, rows, ended) {
  if (rows.length < 2) return;
  const merged = Y.mergeUpdates(rows.map((row) => row.bytes));
  const db = await openDb();
  // Logout bumps the generation before it deletes. A merge that starts afterwards
  // would put the deleted card back.
  if (ended()) return;
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const row of rows) store.delete(row.key);
  store.add({ doc: docKey, bytes: copyBytes(merged) });
  await txDone(tx);
}

async function deleteByRange(range) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const keysReq = store.index(DOC_INDEX).getAllKeys(range);
  keysReq.onsuccess = () => {
    for (const key of keysReq.result || []) store.delete(key);
  };
  await txDone(tx);
}

/**
 * Register the persist listener first, then apply stored updates with origin
 * `"idb"` so they are not written back. `whenReady` always resolves.
 */
export function openDocStore(doc, docKey) {
  let closed = false;
  let hasLocalData = false;
  const gen = sessionGen();

  function ended() {
    return closed || sessionGen() !== gen;
  }

  const persist = (update, origin) => {
    if (ended() || origin === "idb") return;
    // Copy before yielding. Yjs may reuse the buffer once this handler returns.
    const bytes = copyBytes(update);
    const db = dbInstance;
    if (!db) {
      void writeUpdate(docKey, bytes, ended);
      return;
    }
    if (ended()) return;
    try {
      void addUpdate(db, docKey, bytes).catch(() => {});
    } catch {
      void writeUpdate(docKey, bytes, ended);
    }
  };
  doc.on("update", persist);

  const whenReady = (async () => {
    try {
      const rows = await readDocRows(docKey);
      for (const row of rows) {
        if (ended()) return;
        try {
          Y.applyUpdate(doc, row.bytes, "idb");
          hasLocalData = true;
        } catch {
          /* Skip a corrupt row so one bad record cannot wedge the rest. */
        }
      }
      if (!ended() && rows.length >= COMPACT_EVERY) await compactDoc(docKey, rows, ended);
    } catch {
      /* IndexedDB missing or quota — live sync still works. */
    }
  })();

  return {
    whenReady,
    get hasLocalData() {
      return hasLocalData;
    },
    destroy() {
      if (closed) return;
      closed = true;
      doc.off("update", persist);
    },
  };
}

/** Drop one account's rows without touching the signed-in session. */
export async function deleteUserDocs(email) {
  if (!email) return;
  try {
    await deleteByRange(userRange(email));
  } catch {
    /* best-effort */
  }
}

export async function clearDoc(docKey) {
  try {
    await deleteByRange(IDBKeyRange.only(docKey));
  } catch {
    /* best-effort */
  }
}

export async function clearUser(email) {
  // Bump before the delete so another tab's next edit cannot land afterwards.
  bumpSessionGen();
  forgetSession();
  await deleteUserDocs(email);
}
