/** Contenteditable titles. The visible text is the accessible name.
 * A label would replace that name, so the hint is a separate description.
 */

export const BOARD_TITLE_HINT = "Board name. Press Enter to save, Escape to cancel.";
export const CARD_TITLE_HINT = "Card title. Press Enter to save, Escape to cancel.";
export const COLUMN_TITLE_HINT = "Column name. Press Enter to save, Escape to cancel.";

function hintIdFor(el) {
  const described = el.getAttribute("aria-describedby");
  if (described && el.nextElementSibling?.id === described) return described;
  // Column headings are rebuilt while the previous hint is still in the
  // document, so a stable id would describe the node the next paint removes.
  return `hint-${Math.random().toString(36).slice(2, 10)}`;
}

export function setTitleEditing(el, editable, hint) {
  if (!el) return;
  el.removeAttribute("aria-description");
  const existingId = el.getAttribute("aria-describedby");
  const existing = existingId && el.nextElementSibling?.id === existingId ? el.nextElementSibling : null;
  if (editable && hint) {
    el.setAttribute("contenteditable", "plaintext-only");
    el.spellcheck = true;
    const node = existing || document.createElement("span");
    if (!existing) {
      node.id = hintIdFor(el);
      node.className = "visually-hidden";
      el.insertAdjacentElement("afterend", node);
    }
    node.textContent = hint;
    el.setAttribute("aria-describedby", node.id);
    return;
  }
  el.removeAttribute("contenteditable");
  el.spellcheck = false;
  el.removeAttribute("aria-describedby");
  existing?.remove();
}
