import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMN_NAMES } from "../../src/lib/constants.js";
import { RANK_GAP } from "../../src/lib/rank.js";
import { api, closeRoom, openRoom, signIn } from "../helpers/http.js";
import { sendStep1, sendUpdate, waitFor } from "../helpers/yjs-room.js";

async function owner() {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const cookie = await signIn(email);
  return { email, cookie };
}

async function createBoard(cookie, name = "Board") {
  const created = await api("/api/boards", {
    method: "POST",
    cookie,
    body: { name },
  });
  expect(created.status).toBe(201);
  return created.json;
}

async function boardSnapshot(cookie, boardId) {
  const response = await api(`/api/boards/${boardId}/snapshot`, { cookie });
  expect(response.status).toBe(200);
  return response.json;
}

async function createCard(cookie, boardId, columnId, title) {
  const response = await api(`/api/boards/${boardId}/cards`, {
    method: "POST",
    cookie,
    body: { title, columnId },
  });
  expect(response.status).toBe(201);
  return response.json;
}

async function moveCard(cookie, boardId, cardId, body) {
  const response = await api(`/api/boards/${boardId}/cards/${cardId}/move`, {
    method: "POST",
    cookie,
    body,
  });
  expect(response.status).toBe(200);
  return response.json;
}

function cardsIn(snapshot, columnId) {
  return Object.values(snapshot.cards)
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => a.rank - b.rank || String(a.id).localeCompare(String(b.id)));
}

describe("board columns, cards, and ranks", () => {
  it("creates a board, edits columns, and places cards by rank", async () => {
    const { cookie } = await owner();
    const board = await createBoard(cookie, "Roadmap");
    expect(board.role).toBe("owner");

    const initial = await boardSnapshot(cookie, board.id);
    expect(initial.columns.map((column) => column.name)).toEqual(DEFAULT_COLUMN_NAMES);
    const [todo, doing] = initial.columns;

    const added = await api(`/api/boards/${board.id}/columns`, {
      method: "POST",
      cookie,
      body: { name: "Later" },
    });
    expect(added.status).toBe(201);
    const renamed = await api(`/api/boards/${board.id}/columns/${added.json.id}`, {
      method: "PATCH",
      cookie,
      body: { name: "Later on" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe("Later on");

    const order = [added.json.id, ...initial.columns.map((column) => column.id)];
    const reordered = await api(`/api/boards/${board.id}/columns/order`, {
      method: "POST",
      cookie,
      body: { ids: order },
    });
    expect(reordered.status).toBe(200);
    expect((await boardSnapshot(cookie, board.id)).columns.map((column) => column.id)).toEqual(order);

    const first = await createCard(cookie, board.id, todo.id, "A");
    const second = await createCard(cookie, board.id, todo.id, "B");
    const third = await createCard(cookie, board.id, todo.id, "C");
    expect([first.rank, second.rank, third.rank]).toEqual([RANK_GAP, RANK_GAP * 2, RANK_GAP * 3]);

    const blocked = await api(`/api/boards/${board.id}/columns/${todo.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(blocked.status).toBe(400);

    const removed = await api(`/api/boards/${board.id}/columns/${added.json.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);

    const toFront = await moveCard(cookie, board.id, third.id, {
      columnId: todo.id,
      beforeId: first.id,
    });
    expect(toFront.rank).toBe(Math.floor(RANK_GAP / 2));
    expect(toFront.columnId).toBe(todo.id);

    const toDoing = await moveCard(cookie, board.id, second.id, { columnId: doing.id });
    expect(toDoing.columnId).toBe(doing.id);
    expect(toDoing.rank).toBe(RANK_GAP);

    const after = await boardSnapshot(cookie, board.id);
    expect(cardsIn(after, todo.id).map((card) => card.id)).toEqual([third.id, first.id]);
    expect(cardsIn(after, doing.id).map((card) => card.id)).toEqual([second.id]);
    expect(after.columns.some((column) => column.id === added.json.id)).toBe(false);
  });

  it("renumbers a column when the rank gap runs out", async () => {
    const { cookie } = await owner();
    const board = await createBoard(cookie, "Ranks");
    const columnId = (await boardSnapshot(cookie, board.id)).columns[0].id;
    const anchor = await createCard(cookie, board.id, columnId, "anchor");
    let headId = anchor.id;
    let renumbered = false;

    for (let i = 0; i < 20 && !renumbered; i++) {
      const card = await createCard(cookie, board.id, columnId, `n${i}`);
      const moved = await moveCard(cookie, board.id, card.id, { columnId, beforeId: headId });
      const ordered = cardsIn(await boardSnapshot(cookie, board.id), columnId);
      expect(ordered[0].id).toBe(card.id);
      expect(ordered[0].rank).toBe(moved.rank);
      headId = ordered[0].id;
      renumbered =
        ordered.length > 2 && ordered.every((entry, index) => entry.rank === (index + 1) * RANK_GAP);
    }

    expect(renumbered).toBe(true);
  });
});

describe("card and board sockets", () => {
  it("converges two card sockets", async () => {
    const { cookie } = await owner();
    const board = await createBoard(cookie);
    const columnId = (await boardSnapshot(cookie, board.id)).columns[0].id;
    const card = await createCard(cookie, board.id, columnId, "Live");
    const path = `/api/boards/${board.id}/cards/${card.id}/ws`;
    const sockets = [];
    try {
      const a = await openRoom(path, cookie, { writable: true });
      const b = await openRoom(path, cookie, { writable: true });
      sockets.push(a.ws, b.ws);

      a.doc.getText("body").insert(0, "alpha");
      b.doc.getText("body").insert(0, "beta");
      await waitFor(() => {
        const left = a.doc.getText("body").toString();
        const right = b.doc.getText("body").toString();
        return left === right && left.includes("alpha") && left.includes("beta");
      }, "card sockets did not converge");

      const snapshot = await api(`/api/boards/${board.id}/cards/${card.id}/snapshot`, { cookie });
      expect(snapshot.status).toBe(200);
      expect(snapshot.json.body).toBe(a.doc.getText("body").toString());
    } finally {
      for (const ws of sockets) closeRoom(ws);
    }
  });

  it("drops document updates on the board socket", async () => {
    const { cookie } = await owner();
    const board = await createBoard(cookie, "Read only");
    const path = `/api/boards/${board.id}/ws`;
    const sockets = [];
    try {
      const room = await openRoom(path, cookie);
      sockets.push(room.ws);
      const original = room.doc.getMap("meta").get("name");
      expect(original).toBe("Read only");

      let update;
      const onUpdate = (next, origin) => {
        if (origin !== "remote") update = next;
      };
      room.doc.on("update", onUpdate);
      room.doc.getMap("meta").set("name", "forged-name");
      room.doc.off("update", onUpdate);
      expect(update).toBeTruthy();

      const replied = room.waitForStep1();
      sendUpdate(room.ws, update);
      sendStep1(room.ws, room.doc);
      await replied;

      const snapshot = await boardSnapshot(cookie, board.id);
      expect(snapshot.name).toBe(original);

      const fresh = await openRoom(path, cookie);
      sockets.push(fresh.ws);
      expect(fresh.doc.getMap("meta").get("name")).toBe(original);
    } finally {
      for (const ws of sockets) closeRoom(ws);
    }
  });
});

describe("history and tombstones", () => {
  it("pages the changelog with a before cursor", async () => {
    const { email, cookie } = await owner();
    const board = await createBoard(cookie);
    const columnId = (await boardSnapshot(cookie, board.id)).columns[0].id;
    const card = await createCard(cookie, board.id, columnId, "History");
    const archived = await api(`/api/boards/${board.id}/cards/${card.id}/archive`, {
      method: "POST",
      cookie,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);

    const historyPath = `/api/boards/${board.id}/cards/${card.id}/history`;
    const page = await api(`${historyPath}?limit=2`, { cookie });
    expect(page.status).toBe(200);
    expect(page.json.entries).toHaveLength(2);
    expect(page.json.entries[0].id).toBeGreaterThan(page.json.entries[1].id);
    expect(page.json.entries.every((entry) => entry.author === email)).toBe(true);
    expect(page.json.entries.map((entry) => entry.field)).toContain("archived");

    const cursor = page.json.entries[1].id;
    const older = await api(`${historyPath}?limit=2&before=${cursor}`, { cookie });
    expect(older.status).toBe(200);
    expect(older.json.entries.length).toBeGreaterThan(0);
    expect(older.json.entries.every((entry) => entry.id < cursor)).toBe(true);
    const seen = new Set(page.json.entries.map((entry) => entry.id));
    expect(older.json.entries.some((entry) => seen.has(entry.id))).toBe(false);

    expect((await api(`${historyPath}?limit=abc`, { cookie })).status).toBe(400);
    expect((await api(`${historyPath}?before=0`, { cookie })).status).toBe(400);
  });

  it("keeps a deleted card tombstoned", async () => {
    const { cookie } = await owner();
    const board = await createBoard(cookie);
    const columnId = (await boardSnapshot(cookie, board.id)).columns[0].id;
    const card = await createCard(cookie, board.id, columnId, "Gone");
    const cardPath = `/api/boards/${board.id}/cards/${card.id}`;

    const deleted = await api(cardPath, { method: "DELETE", cookie });
    expect(deleted.status).toBe(200);

    const first = await api(`${cardPath}/snapshot`, { cookie });
    const second = await api(`${cardPath}/snapshot`, { cookie });
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect((await boardSnapshot(cookie, board.id)).cards[card.id]).toBeUndefined();
    await expect(openRoom(`${cardPath}/ws`, cookie)).rejects.toThrow(/404/);
    expect((await api(`${cardPath}/history`, { cookie })).status).toBe(404);
  });
});
