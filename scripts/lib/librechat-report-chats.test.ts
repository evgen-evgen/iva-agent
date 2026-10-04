import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { createReportChats } = createRequire(import.meta.url)(
  "../../librechat/iva-report-chats.cjs",
) as {
  createReportChats: (options: unknown) => {
    ensure: (
      user: string,
      detail: unknown,
    ) => Promise<{ conversationId: string } | null>;
  };
};

void test("native report migration preserves message chains, isolates readers and respects later edits/deletion", async () => {
  type Row = Record<string, unknown> & { messages?: unknown[] };
  type Change = {
    $setOnInsert?: Row;
    $set?: Row;
    $addToSet?: { messages: { $each: unknown[] } };
  };
  const model = () => {
    const rows: Row[] = [];
    const find = (filter: Row) =>
      rows.find((row) =>
        Object.entries(filter).every(([key, value]) => row[key] === value),
      );
    const update = (filter: Row, change: Change, options: Row = {}) => {
      let row = find(filter);
      if (!row && options.upsert) {
        row = { _id: `row-${rows.length}`, ...filter, ...change.$setOnInsert };
        rows.push(row);
      }
      if (row) {
        Object.assign(row, change.$set || {});
        if (change.$addToSet)
          row.messages = [
            ...new Set([
              ...(row.messages || []),
              ...change.$addToSet.messages.$each,
            ]),
          ];
      }
      return row;
    };
    return {
      rows,
      findOne: (filter: Row) => ({ lean: () => Promise.resolve(find(filter)) }),
      findOneAndUpdate: (filter: Row, change: Change, options: Row) => {
        const result = Promise.resolve(update(filter, change, options));
        return Object.assign(result, { lean: () => result });
      },
      updateOne: (filter: Row, change: Change, options?: Row) =>
        Promise.resolve(update(filter, change, options)),
    };
  };
  const models = {
    Conversation: model(),
    Message: model(),
    ChatProject: model(),
  };
  const receiptRows: Row[] = [];
  const receipts = {
    findOne: (filter: Row) =>
      Promise.resolve(receiptRows.find((row) => row._id === filter._id)),
    updateOne: (filter: Row, change: Change) =>
      Promise.resolve(receiptRows.push({ ...filter, ...change.$set })),
  };
  let refreshes = 0;
  const chats = createReportChats({
    models,
    receipts,
    refreshStats: () => {
      refreshes++;
      return Promise.resolve();
    },
  });
  const detail = {
    notification: {
      id: "report",
      kind: "report",
      title: "Отчёт",
      body: "17 × 19 = 323",
      createdAt: "2026-10-04T13:00:00Z",
    },
    messages: [
      { role: "user", body: "Почему?", createdAt: "2026-10-04T13:01:00Z" },
      {
        role: "assistant",
        body: "17 × (20 − 1)",
        createdAt: "2026-10-04T13:02:00Z",
      },
    ],
  };
  const [first, repeated] = await Promise.all([
    chats.ensure("admin", detail),
    chats.ensure("admin", detail),
  ]);
  assert.deepEqual(first, repeated);
  assert.equal(models.Message.rows.length, 3);
  assert.equal(models.Message.rows[0].text, detail.notification.body);
  assert.equal(
    models.Message.rows[1].parentMessageId,
    models.Message.rows[0].messageId,
  );
  assert.equal(
    models.Message.rows[2].parentMessageId,
    models.Message.rows[1].messageId,
  );
  assert.equal(models.Message.rows[1].isCreatedByUser, true);
  assert.equal(models.Conversation.rows[0].endpoint, "Iva");
  assert.equal(models.ChatProject.rows[0].name, "Входящие Ивы");
  models.Conversation.rows[0].title = "Моё название";
  models.Conversation.rows[0].chatProjectId = "moved-project";
  models.Conversation.rows[0].isArchived = true;
  await chats.ensure("admin", detail);
  assert.equal(models.Conversation.rows[0].title, "Моё название");
  assert.equal(models.Conversation.rows[0].chatProjectId, "moved-project");
  assert.equal(models.Conversation.rows[0].isArchived, true);
  assert.equal(refreshes, 1);
  const other = await chats.ensure("dima", { ...detail, messages: [] });
  assert.ok(first);
  assert.ok(other);
  assert.notEqual(first.conversationId, other.conversationId);
  assert.equal(models.ChatProject.rows.length, 2);
  assert.equal(
    models.Message.rows.filter((row) => row.user === "dima").length,
    1,
  );
  models.Conversation.rows.splice(0, 1);
  assert.equal(await chats.ensure("admin", detail), null);
  assert.equal(models.Conversation.rows.length, 1);
  assert.equal(
    await chats.ensure("admin", {
      notification: { ...detail.notification, kind: "reminder" },
    }),
    null,
  );
});
