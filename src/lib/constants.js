export const WORKSPACE_ID = "default";

/** Machine-readable job lifecycle statuses. Display labels are separate. */
export const JOB_STATUSES = [
  "lead",
  "scoped",
  "active",
  "review",
  "done",
  "invoiced",
  "paid",
];

/** Debounce window before the materialized snapshot is mirrored to git. */
export const GIT_FLUSH_ALARM_MS = 300_000;
