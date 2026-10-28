/** Fold the Yjs update log into one snapshot once it reaches this many rows. */
export const YJS_COMPACT_EVERY = 50;

/** Compact a shorter update log after the room has been idle this long. */
export const YJS_COMPACT_ALARM_MS = 30_000;

/**
 * Schema version stored on each Yjs snapshot. Bump when migrateDoc changes.
 * migrateDoc must bring every older doc all the way here; the snapshot is
 * stamped with this value after it runs.
 */
export const DOC_SCHEMA_VERSION = 1;

/** Keep this many newest changelog rows per card. */
export const CHANGELOG_MAX_ENTRIES = 500;

/** First retry delay for a failed cross-DO replica write; doubles each attempt. */
export const OUTBOUND_BACKOFF_MS = 5_000;
export const OUTBOUND_BACKOFF_MAX_MS = 300_000;

export const BOARD_NAME_MAX = 80;
export const COLUMN_NAME_MAX = 80;
export const CARD_TITLE_MAX = 200;
export const ASSIGNEE_MAX = 80;
export const DUE_MAX = 40;
export const LABEL_MAX_COUNT = 20;
export const LABEL_MAX_LENGTH = 30;

/** Default columns for a newly created board. */
export const DEFAULT_COLUMN_NAMES = ["To do", "Doing", "Done"];

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const BOARD_ID_RE = new RegExp(`^board_${UUID}$`, "i");
export const CARD_ID_RE = new RegExp(`^card_${UUID}$`, "i");
export const COLUMN_ID_RE = new RegExp(`^col_${UUID}$`, "i");

/** Auth */
export const SESSION_COOKIE = "tk_session";
export const SESSION_TTL_SEC = 14 * 24 * 60 * 60;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_EMAIL = 3;
export const RATE_LIMIT_IP = 10;
export const EMAIL_MAX = 254;
export const AUTH_PURGE_ALARM_MS = 24 * 60 * 60 * 1000;

/** Board membership roles (higher rank includes lower). */
export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
export const BOARD_ROLES = Object.keys(ROLE_RANK);
/** Roles that can be granted via invite link (owners are created or promoted separately). */
export const INVITE_ROLES = ["editor", "viewer"];
export const WS_CLOSE_REVOKED = 4403;
