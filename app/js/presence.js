/** Render who's in a Yjs awareness room. */

/** Card page focus keys. The server drops anything else before relay. */
const EDITING_FIELDS = new Set(["title", "column", "assignee", "due", "body", "label"]);
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

/**
 * Bind a presence list to an awareness instance.
 * Returns `{ setEditing, destroy }`.
 * `setEditing(fieldKey|null)` publishes which field this client is editing.
 * The room relay stamps `user.email`; this only renders that plain text.
 */
export function bindPresence(el, awareness, { selfEmail } = {}) {
  if (!el || !awareness) {
    return { setEditing() {}, destroy() {} };
  }

  const mine = presenceEmail(selfEmail).toLowerCase();

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

    if (peers.length === 0) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }

    el.hidden = false;
    const label = document.createElement("span");
    label.className = "presence-label";
    label.textContent = "Here:";
    const list = document.createElement("ul");
    list.className = "presence-list";
    for (const peer of peers) {
      const li = document.createElement("li");
      li.textContent = peer.editing ? `${peer.email} (${peer.editing})` : peer.email;
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
      awareness.off("change", onChange);
      el.hidden = true;
      el.replaceChildren();
    },
  };
}
