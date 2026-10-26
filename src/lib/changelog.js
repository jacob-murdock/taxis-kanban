/** Compare materialized job snapshots for changelog projection. */

const TRACKED = [
  { field: "title", get: (j) => j.title },
  { field: "status", get: (j) => j.status },
  { field: "slug", get: (j) => j.slug },
  { field: "client.name", get: (j) => j.client?.name ?? "" },
  { field: "client.contact", get: (j) => j.client?.contact ?? "" },
  {
    field: "amount",
    get: (j) => (j.amount?.value ? String(j.amount.value) : "0"),
  },
  { field: "due", get: (j) => j.due ?? "" },
  { field: "body", get: (j) => j.body ?? "" },
];

export function diffJobSnapshots(prev, next) {
  const changes = [];
  for (const { field, get } of TRACKED) {
    const before = get(prev);
    const after = get(next);
    if (before !== after) {
      changes.push({
        field,
        prev: before || null,
        next: after || null,
      });
    }
  }
  return changes;
}
