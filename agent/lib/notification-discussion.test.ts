/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement production Promise contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discussNotification,
  readDiscussion,
  discussionToken,
} from "./notification-discussion.ts";

void test("report discussions persist, isolate accounts/reports, reject simultaneous turns and recover after failure", async () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "iva-discussion-"));
  process.env.ASSISTANT_DATA_DIR = directory;
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = discussNotification(
      "report-a",
      "ceo",
      "Что делать?",
      async () => {
        await held;
        return "Первый шаг";
      },
    );
    assert.equal(
      await discussNotification(
        "report-a",
        "ceo",
        "Ещё вопрос",
        async () => "bad",
      ),
      null,
    );
    release();
    await first;
    const saved = await readDiscussion("report-a", "ceo");
    assert.deepEqual(
      saved.messages.map((message) => message.body),
      ["Что делать?", "Первый шаг"],
    );
    assert.deepEqual((await readDiscussion("report-a", "admin")).messages, []);
    assert.deepEqual((await readDiscussion("report-b", "ceo")).messages, []);
    assert.notEqual(
      discussionToken("report-a", "ceo"),
      discussionToken("report-a", "admin"),
    );
    await assert.rejects(
      discussNotification("report-a", "ceo", "failed", async () => {
        throw new Error("offline");
      }),
    );
    assert.equal((await readDiscussion("report-a", "ceo")).messages.length, 2);
    await discussNotification(
      "report-a",
      "ceo",
      "А потом?",
      async (history) => {
        assert.equal(history.messages.length, 2);
        return "Следующий шаг";
      },
    );
    assert.equal((await readDiscussion("report-a", "ceo")).messages.length, 4);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
