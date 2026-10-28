/** Sign-in panel for the board list. */

import { API, requestJson, safeNextPath } from "./config.js";
import { bumpSessionGen, forgetSession, rememberSession } from "./local-session.js";

const panel = document.getElementById("auth-panel");
const errorEl = document.getElementById("page-error");

if (panel) {
  initAuthPanel(panel).catch((err) => {
    setError(err.message || "Auth unavailable");
  });
}

function setError(message) {
  if (errorEl) errorEl.textContent = message || "";
}

function nextPath() {
  return safeNextPath(new URLSearchParams(location.search).get("next"));
}

async function initAuthPanel(root) {
  let me = null;
  try {
    me = await requestJson(API.me);
  } catch (err) {
    if (err.status !== 401) throw err;
  }

  root.replaceChildren();
  if (me?.email) {
    rememberSession({ email: me.email });
    root.append(buildSignedIn(me.email));
    return;
  }
  root.append(buildSignInForm());
}

function buildSignedIn(email) {
  const wrap = document.createElement("div");
  wrap.className = "auth-session";

  const label = document.createElement("span");
  label.className = "auth-email";
  label.textContent = email;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = "Sign out";
  button.addEventListener("click", async () => {
    button.disabled = true;
    setError("");
    try {
      await requestJson(API.authLogout, { method: "POST", body: {} });
      // Bump before the IndexedDB import so another tab stops writing immediately.
      bumpSessionGen();
      forgetSession();
      try {
        const { clearUser } = await import("./doc-store.js");
        await clearUser(email);
      } catch {
        /* The cookie is already gone if the log cannot be cleared. */
      }
      location.assign("/");
    } catch (err) {
      setError(err.message || "Sign out failed");
      button.disabled = false;
    }
  });

  wrap.append(label, button);
  return wrap;
}

function buildSignInForm() {
  const form = document.createElement("form");
  form.className = "auth-form";
  form.setAttribute("novalidate", "");

  const input = document.createElement("input");
  input.type = "email";
  input.name = "email";
  input.required = true;
  input.autocomplete = "email";
  input.placeholder = "you@example.com";
  input.setAttribute("aria-label", "Email");
  input.maxLength = 254;

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "btn-primary";
  button.textContent = "Email magic link";

  const hint = document.createElement("p");
  hint.className = "auth-hint";
  hint.hidden = true;

  form.append(input, button, hint);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    hint.hidden = true;
    button.disabled = true;
    try {
      await requestJson(API.authRequest, {
        method: "POST",
        body: { email: input.value, next: nextPath() },
      });
      hint.textContent =
        "If that address can sign in, a link is on its way (check the Worker console when mail is unset).";
      hint.hidden = false;
      input.value = "";
    } catch (err) {
      setError(err.message || "Could not request link");
    } finally {
      button.disabled = false;
    }
  });

  return form;
}
