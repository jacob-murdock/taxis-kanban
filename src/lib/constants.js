/** Debounce window before materializing a card snapshot into DO storage. */
export const SNAPSHOT_ALARM_MS = 300_000;

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
