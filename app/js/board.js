import { API } from "./config.js";
import { JOB_STATUSES } from "./constants.js";
import { connectYjsRoom } from "./yjs-sync.js";

const statusEl = document.getElementById("connection-status");
const newJobBtn = document.getElementById("new-job-btn");

const columns = new Map(
  [...document.querySelectorAll(".board-column")].map((col) => [
    col.dataset.status,
    col.querySelector("[data-dropzone]"),
  ]),
);

let doc = null;
let rendering = false;

async function bootstrap() {
  const room = connectYjsRoom(API.boardWs);
  room.bindStatus(statusEl);

  try {
    doc = await room.ready;
    renderFromDoc();
    observeDoc();
  } catch (err) {
    console.error(err);
    setStatus("error", "Could not sync board");
  }
}

function observeDoc() {
  const cards = doc.getArray("cards");
  cards.observeDeep(() => {
    if (!rendering) renderFromDoc();
  });
}

function renderFromDoc() {
  rendering = true;
  const cards = doc
    .getArray("cards")
    .toArray()
    .filter(Boolean);

  for (const status of JOB_STATUSES) {
    columns.get(status)?.replaceChildren();
  }

  for (const card of cards) {
    const list = columns.get(card.status) ?? columns.get("lead");
    if (!list) continue;
    list.appendChild(buildCardEl(card));
  }

  rendering = false;
}

function buildCardEl(card) {
  const li = document.createElement("li");
  li.dataset.jobId = card.id;
  li.draggable = true;

  const link = document.createElement("a");
  link.href = `/job?id=${encodeURIComponent(card.id)}`;
  link.textContent = card.title || card.slug || card.id;
  li.appendChild(link);

  if (card.clientName) {
    const sub = document.createElement("small");
    sub.textContent = card.clientName;
    li.appendChild(document.createElement("br"));
    li.appendChild(sub);
  }

  const statusRow = document.createElement("label");
  statusRow.className = "card-status";
  statusRow.append("Status: ");

  const select = document.createElement("select");
  for (const s of JOB_STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === card.status) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => moveCard(card.id, select.value));
  statusRow.appendChild(select);
  li.appendChild(statusRow);

  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", card.id);
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  return li;
}

function moveCard(jobId, newStatus) {
  const cards = doc.getArray("cards");
  const items = cards.toArray();
  const idx = items.findIndex((c) => c.id === jobId);
  if (idx < 0) return;

  if (items[idx].status === newStatus) return;

  // Optimistic local move for instant feedback.
  const updated = {
    ...items[idx],
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };
  doc.transact(() => {
    cards.delete(idx, 1);
    cards.insert(idx, [updated]);
  });

  // Report to the JobDO (source of truth); it echoes the card back to the board.
  fetch(API.jobStatus(jobId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: newStatus }),
  }).catch((err) => console.error("Status update failed", err));
}

function setupDropZones() {
  for (const [status, list] of columns) {
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      list.classList.add("drag-over");
    });
    list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      list.classList.remove("drag-over");
      const jobId = e.dataTransfer.getData("text/plain");
      if (jobId) moveCard(jobId, status);
    });
  }
}

async function createJob() {
  const title = window.prompt("Job title:");
  if (!title?.trim()) return;

  newJobBtn.disabled = true;
  try {
    const res = await fetch(API.createJob, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (!res.ok) throw new Error(`Create failed (${res.status})`);
    // Board card arrives via Yjs broadcast from BoardDO.
  } catch (err) {
    console.error(err);
    window.alert("Could not create job.");
  } finally {
    newJobBtn.disabled = false;
  }
}

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
}

newJobBtn?.addEventListener("click", createJob);
setupDropZones();
bootstrap();
