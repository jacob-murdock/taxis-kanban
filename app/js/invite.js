/** Accept a board invite token from /invite?token=… */

import { API, requestJson, safeNextPath } from "./config.js";

const statusEl = document.getElementById("invite-status");
const acceptBtn = document.getElementById("accept-btn");
const errorEl = document.getElementById("page-error");

const token = new URLSearchParams(location.search).get("token")?.trim().toLowerCase() || "";

function setError(message) {
  errorEl.textContent = message || "";
}

function inviteNext() {
  return `/invite?token=${encodeURIComponent(token)}`;
}

async function bootstrap() {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    statusEl.textContent = "This invite link is invalid or incomplete.";
    return;
  }

  try {
    await requestJson(API.me);
  } catch (err) {
    if (err.status === 401) {
      statusEl.textContent = "Sign in to accept this invite.";
      location.replace(`/?next=${encodeURIComponent(safeNextPath(inviteNext()))}`);
      return;
    }
    statusEl.textContent = "Could not check your session.";
    setError(err.message);
    return;
  }

  statusEl.textContent = "You’re signed in. Accept to join this board.";
  acceptBtn.hidden = false;
}

acceptBtn.addEventListener("click", async () => {
  acceptBtn.disabled = true;
  setError("");
  try {
    const result = await requestJson(API.inviteAccept, {
      method: "POST",
      body: { token },
    });
    statusEl.textContent = result.alreadyMember
      ? "You were already a member. Opening the board…"
      : "Invite accepted. Opening the board…";
    location.replace(`/b/${encodeURIComponent(result.boardId)}`);
  } catch (err) {
    setError(err.message || "Could not accept invite");
    acceptBtn.disabled = false;
  }
});

bootstrap();
