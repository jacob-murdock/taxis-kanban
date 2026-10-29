/** Render who's in a Yjs awareness room. */

import { announce } from "./announce.js";
import { createRosterAnnouncer } from "./peer-roster.js";

/** Card page focus keys. The server drops anything else before relay. */
const EDITING_FIELDS = new Set(["title", "column", "assignee", "due", "body", "label"]);
const EDITING_LABELS = {
  title: "the title",
  column: "the column",
  assignee: "the assignee",
  due: "the due date",
  body: "the notes",
  label: "the labels",
};
const EMAIL_MAX = 254;
/** One row per person. A cap stops a bad frame from building an unbounded list. */
const MAX_ROWS = 50;

function presenceEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim();
  if (!email || email.length > EMAIL_MAX) return "";
  if (/[\u0000-\u001f\u007f]/.test(email)) return "";
  return email;
}

const AVATAR_SLOTS = 6;

function avatarSlot(email) {
  let hash = 0;
  const key = email.toLowerCase();
  for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  return hash % AVATAR_SLOTS;
}

function initials(email) {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`
      : (parts[0] || local).replace(/[^a-zA-Z0-9]/g, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}

/**
 * Bind a presence list to an awareness instance.
 * Returns `{ setEditing, destroy }`.
 * `setEditing(fieldKey|null)` publishes which field this client is editing.
 * The room relay stamps `user.email`; this only renders that plain text.
 */
export function bindPresence(el, awareness, { selfEmail, ready } = {}) {
  if (!el || !awareness) {
    return { setEditing() {}, destroy() {} };
  }

  const mine = presenceEmail(selfEmail).toLowerCase();
  const announcer = createRosterAnnouncer(announce, { ready });

  const render = () => {
    const byEmail = new Map();
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const email = presenceEmail(state?.user?.email);
      if (!email || email.toLowerCase() === mine) continue;
      const editing = EDITING_FIELDS.has(state?.editing) ? state.editing : null;
      const key = email.toLowerCase();
      const prev = byEmail.get(key);
      if (!prev) byEmail.set(key, { email, editing });
      else if (!prev.editing && editing) prev.editing = editing;
    }
    const peers = [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
    if (peers.length > MAX_ROWS) peers.length = MAX_ROWS;
    announcer.see(new Map(peers.map((peer) => [peer.email.toLowerCase(), peer.email])));

    if (peers.length === 0) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }

    el.hidden = false;
    const label = document.createElement("span");
    label.className = "presence-label";
    label.textContent = "Here:";
    label.setAttribute("aria-hidden", "true");
    const list = document.createElement("ul");
    list.className = "presence-list";
    list.setAttribute("aria-label", "People here");
    for (const peer of peers) {
      const li = document.createElement("li");
      li.className = "presence-avatar";
      const editing = EDITING_LABELS[peer.editing];
      const name = editing ? `${peer.email}, editing ${editing}` : peer.email;
      if (peer.editing) li.classList.add("is-editing");

      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.title = name;
      avatar.style.setProperty("--avatar", `var(--avatar-${avatarSlot(peer.email)})`);
      avatar.textContent = initials(peer.email);

      const text = document.createElement("span");
      text.className = "visually-hidden";
      text.textContent = name;

      li.append(avatar, text);
      list.append(li);
    }
    el.replaceChildren(label, list);
  };

  const onChange = () => render();
  awareness.on("change", onChange);
  render();

  return {
    setEditing(field) {
      const next = field || null;
      const cur = awareness.getLocalState()?.editing ?? null;
      if (cur === next) return;
      awareness.setLocalStateField("editing", next);
    },
    destroy() {
      announcer.destroy();
      awareness.off("change", onChange);
      el.hidden = true;
      el.replaceChildren();
    },
  };
}
