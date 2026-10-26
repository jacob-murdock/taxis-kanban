/** Read a card Y.Doc (fields map, labels array, body text). */

export function readCard(doc) {
  const fields = doc.getMap("fields");
  const due = fields.get("due");

  return {
    id: fields.get("id") ?? "",
    boardId: fields.get("boardId") ?? "",
    title: fields.get("title") ?? "Untitled",
    columnId: fields.get("columnId") ?? null,
    due: due == null || due === "" ? null : due,
    assignee: String(fields.get("assignee") ?? ""),
    archived: fields.get("archived") === true,
    labels: doc
      .getArray("labels")
      .toArray()
      .map((label) => String(label)),
    body: doc.getText("body").toString(),
  };
}
