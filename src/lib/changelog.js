/** Compare materialized card snapshots for changelog projection. */

function labelsKey(labels) {
  return JSON.stringify(Array.isArray(labels) ? labels : []);
}

const TRACKED = [
  { field: "title", get: (c) => c.title ?? "" },
  { field: "columnId", get: (c) => c.columnId ?? "" },
  { field: "due", get: (c) => c.due ?? "" },
  { field: "assignee", get: (c) => c.assignee ?? "" },
  { field: "labels", get: (c) => labelsKey(c.labels) },
  { field: "archived", get: (c) => (c.archived ? "true" : "false") },
  { field: "body", get: (c) => c.body ?? "" },
];

export function diffCardSnapshots(prev, next) {
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
