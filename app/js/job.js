import { API } from "./config.js";
import { JOB_STATUSES } from "./constants.js";
import { connectYjsRoom } from "./yjs-sync.js";
import { formatAmount, parseAmount, readJob } from "./job-model.js";

const params = new URLSearchParams(window.location.search);
const jobId = params.get("id");

const statusEl = document.getElementById("connection-status");
const titleEl = document.getElementById("job-title");
const metaEl = document.getElementById("job-meta");
const historyList = document.getElementById("history-list");

const fieldStatus = document.getElementById("field-status");
const fieldClient = document.getElementById("field-client");
const fieldAmount = document.getElementById("field-amount");
const fieldDue = document.getElementById("field-due");
const fieldBody = document.getElementById("job-body");

let doc = null;
let syncing = false;
let historyTimer = null;
const focused = new Set();

async function bootstrap() {
  if (!jobId) {
    titleEl.textContent = "No job selected";
    setStatus("error", "Missing ?id= parameter");
    return;
  }

  loadHistory();
  wireEditors();

  const room = connectYjsRoom(API.jobWs(jobId));
  room.bindStatus(statusEl);

  try {
    doc = await room.ready;
    renderFromDoc();
    observeDoc();
  } catch (err) {
    console.error(err);
    setStatus("error", "Could not sync job");
  }
}

function observeDoc() {
  doc.getMap("fields").observeDeep(() => {
    if (!syncing) renderFromDoc();
    scheduleHistoryRefresh();
  });
  doc.getText("body").observe(() => {
    if (!syncing && !focused.has("body")) {
      fieldBody.value = doc.getText("body").toString();
    }
    scheduleHistoryRefresh();
  });
}

function scheduleHistoryRefresh() {
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void loadHistory();
  }, 500);
}

function renderFromDoc() {
  syncing = true;
  const job = readJob(doc);

  if (focused.has("title") === false) titleEl.textContent = job.title;
  metaEl.textContent = [job.slug, job.id].filter(Boolean).join(" · ");

  if (focused.has("status") === false) fieldStatus.value = job.status;
  if (focused.has("client") === false) fieldClient.value = job.client.name;
  if (focused.has("amount") === false) fieldAmount.value = formatAmount(job.amount);
  if (focused.has("due") === false) fieldDue.value = job.due ?? "";
  if (focused.has("body") === false) fieldBody.value = job.body;

  document.title = `${job.title} · Taxis Kanban`;
  syncing = false;
}

function wireEditors() {
  trackFocus(titleEl, "title");
  trackFocus(fieldStatus, "status");
  trackFocus(fieldClient, "client");
  trackFocus(fieldAmount, "amount");
  trackFocus(fieldDue, "due");
  trackFocus(fieldBody, "body");

  titleEl.addEventListener("blur", () => {
    const fields = doc?.getMap("fields");
    if (!fields) return;
    const next = titleEl.textContent.trim() || "Untitled Job";
    doc.transact(() => fields.set("title", next));
  });

  fieldStatus.addEventListener("change", () => {
    doc?.transact(() => doc.getMap("fields").set("status", fieldStatus.value));
  });

  fieldClient.addEventListener("change", () => {
    const fields = doc.getMap("fields");
    const prev = fields.get("client") ?? { name: "", contact: "" };
    doc.transact(() =>
      fields.set("client", { ...prev, name: fieldClient.value.trim() }),
    );
  });

  fieldAmount.addEventListener("change", () => {
    const fields = doc.getMap("fields");
    const prev = fields.get("amount") ?? { value: 0, currency: "USD" };
    doc.transact(() =>
      fields.set("amount", {
        ...prev,
        value: parseAmount(fieldAmount.value),
        currency: "USD",
      }),
    );
  });

  fieldDue.addEventListener("change", () => {
    doc?.transact(() =>
      doc.getMap("fields").set("due", fieldDue.value || null),
    );
  });

  fieldBody.addEventListener("input", () => {
    if (!doc) return;
    applyTextDiff(doc.getText("body"), fieldBody.value);
  });
}

/**
 * Apply only the changed region of `next` to a Y.Text, instead of replacing
 * the whole document. This keeps untouched regions intact so concurrent edits
 * from other collaborators merge cleanly (and don't reset their cursors).
 */
function applyTextDiff(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;

  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  ytext.doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  });
}

function trackFocus(el, key) {
  el.addEventListener("focus", () => focused.add(key));
  el.addEventListener("blur", () => focused.delete(key));
}

async function loadHistory() {
  try {
    const res = await fetch(API.jobHistory(jobId));
    if (!res.ok) return;
    const { entries } = await res.json();
    renderHistory(entries ?? []);
  } catch {
    // History is best-effort; the page works without it.
  }
}

function renderHistory(entries) {
  historyList.replaceChildren();
  if (!entries.length) {
    historyList.innerHTML = '<li class="placeholder">No changes recorded yet.</li>';
    return;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.textContent = `${entry.ts} — ${entry.field}: ${entry.prev ?? "∅"} → ${entry.next ?? "∅"}`;
    historyList.appendChild(li);
  }
}

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
}

bootstrap();
