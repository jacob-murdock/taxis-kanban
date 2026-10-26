import { JOB_STATUSES } from "./constants.js";

export function readJob(doc) {
  const fields = doc.getMap("fields");
  const body = doc.getText("body").toString();
  const client = fields.get("client") ?? { name: "", contact: "" };
  const amount = fields.get("amount") ?? { value: 0, currency: "USD" };
  const links = fields.get("links") ?? {};

  const status = fields.get("status") ?? "lead";

  return {
    id: fields.get("id") ?? "",
    slug: fields.get("slug") ?? "",
    title: fields.get("title") ?? "Untitled Job",
    status: JOB_STATUSES.includes(status) ? status : "lead",
    client: {
      name: String(client.name ?? ""),
      contact: String(client.contact ?? ""),
    },
    amount: {
      value: Number(amount.value ?? 0),
      currency: String(amount.currency ?? "USD"),
    },
    due: fields.get("due") ?? null,
    links: {
      repo: links.repo ? String(links.repo) : "",
      staging: links.staging ? String(links.staging) : "",
      prod: links.prod ? String(links.prod) : "",
    },
    body,
  };
}

export function formatAmount(amount) {
  if (!amount?.value) return "";
  return (amount.value / 100).toFixed(2);
}

export function parseAmount(dollars) {
  const n = Number.parseFloat(dollars);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}
