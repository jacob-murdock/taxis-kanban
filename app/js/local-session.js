/** Last signed-in email and per-board role, plus a generation bumped on logout.
 * The card page uses this when a reload cannot reach `/api/me` or the snapshot,
 * so an editor's IndexedDB copy can still open. Logout bumps the generation
 * first; open card logs stop writing when it no longer matches.
 */

const SESSION_KEY = "taxis.session";
const GEN_KEY = "taxis.gen";
const ROLES = new Set(["owner", "editor", "viewer"]);

export function sessionGen() {
  try {
    return localStorage.getItem(GEN_KEY) || "0";
  } catch {
    return "0";
  }
}

export function bumpSessionGen() {
  try {
    const next = Number(sessionGen()) + 1;
    localStorage.setItem(GEN_KEY, String(Number.isFinite(next) && next > 0 ? next : Date.now()));
  } catch {
    /* private mode */
  }
}

export function cachedSession() {
  try {
    const data = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    const email = typeof data?.email === "string" && data.email ? data.email : null;
    const roles = {};
    if (data?.roles && typeof data.roles === "object") {
      for (const [boardId, role] of Object.entries(data.roles)) {
        if (ROLES.has(role)) roles[boardId] = role;
      }
    }
    return { email, roles };
  } catch {
    return { email: null, roles: {} };
  }
}

export function rememberSession({ email, boardId, role } = {}) {
  try {
    const current = cachedSession();
    const nextEmail = typeof email === "string" && email ? email : current.email;
    if (!nextEmail) return;
    const switching = Boolean(email && current.email && email !== current.email);
    // Stop the previous account's open tabs before its rows are removed.
    if (switching) bumpSessionGen();
    const roles = switching ? {} : { ...current.roles };
    if (boardId && ROLES.has(role)) roles[boardId] = role;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ email: nextEmail, roles }));
    if (switching) {
      const previous = current.email;
      void import("./doc-store.js")
        .then(({ deleteUserDocs }) => deleteUserDocs(previous))
        .catch(() => {});
    }
  } catch {
    /* private mode */
  }
}

export function forgetSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}
