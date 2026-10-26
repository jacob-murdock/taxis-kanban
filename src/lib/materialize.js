import * as Y from "yjs";
import { JOB_STATUSES } from "./constants.js";

function readYMapValue(map, key, fallback) {
  const value = map.get(key);
  return value === undefined ? fallback : value;
}

function readNestedMap(map, key) {
  const nested = map.get(key);
  if (nested instanceof Y.Map) {
    return nested.toJSON();
  }
  if (nested && typeof nested === "object") {
    return nested;
  }
  return {};
}

export function createEmptyJobDoc(id) {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");

  fields.set("id", id);
  fields.set("slug", "");
  fields.set("title", "Untitled Job");
  fields.set("status", "lead");
  fields.set("client", { name: "", contact: "" });
  fields.set("amount", { value: 0, currency: "USD" });
  fields.set("due", null);
  fields.set("links", {});
  fields.set("invoice", { sent: false, paidAt: null });

  doc.getText("body").insert(0, "## Background\n\n## Scope\n\n## Log\n");

  return doc;
}

export function materializeJob(doc) {
  const fields = doc.getMap("fields");
  const body = doc.getText("body").toString();

  const status = readYMapValue(fields, "status", "lead");
  const normalizedStatus = JOB_STATUSES.includes(status) ? status : "lead";

  const client = readNestedMap(fields, "client");
  const amount = readNestedMap(fields, "amount");
  const links = readNestedMap(fields, "links");
  const invoice = readNestedMap(fields, "invoice");

  return {
    id: readYMapValue(fields, "id", ""),
    slug: readYMapValue(fields, "slug", ""),
    title: readYMapValue(fields, "title", "Untitled Job"),
    status: normalizedStatus,
    client: {
      name: String(client.name ?? ""),
      contact: String(client.contact ?? ""),
    },
    amount: {
      value: Number(amount.value ?? 0),
      currency: String(amount.currency ?? "USD"),
    },
    due: readYMapValue(fields, "due", null),
    links: {
      repo: links.repo ? String(links.repo) : undefined,
      staging: links.staging ? String(links.staging) : undefined,
      prod: links.prod ? String(links.prod) : undefined,
    },
    invoice: {
      sent: Boolean(invoice.sent ?? false),
      paidAt: invoice.paidAt ? String(invoice.paidAt) : null,
    },
    body,
  };
}

export function materializeBoardCards(doc) {
  const cards = doc.getArray("cards");
  return cards.toArray();
}

export function generateJobId() {
  return `job_${crypto.randomUUID()}`;
}
