import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunTaskCommand } from "./run-task.ts";
import { createCliRuntime } from "./runtime.ts";
import { listNotifications } from "#lib/notification-store.ts";

void test("due assignments execute work, archive results and send buttons; failures never become reminder success", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-task-"));
  const before = process.env.ASSISTANT_DATA_DIR;
  const url = process.env.LIBRECHAT_PUBLIC_URL;
  const savedFetch = globalThis.fetch;
  process.env.ASSISTANT_DATA_DIR = root;
  process.env.LIBRECHAT_PUBLIC_URL = "https://libre.example.com";
  await writeFile(
    join(root, ".env"),
    "TELEGRAM_BOT_TOKEN=test\nTELEGRAM_NOTIFICATION_CHAT_ID=9\nLIBRECHAT_PUBLIC_URL=https://libre.example.com\n",
  );
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (_url, init) => {
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return Promise.resolve(new Response("{}"));
  };
  try {
    const cmd = createRunTaskCommand(createCliRuntime(root), {
      run: (prompt) => {
        assert.match(prompt, /Execute the assignment yourself/u);
        assert.match(prompt, /actual web research/u);
        return Promise.resolve({
          status: "waiting",
          message: "# Результат\nРабота выполнена.",
        });
      },
    });
    await cmd(["Подготовь отчёт"]);
    const items = await listNotifications();
    assert.equal(items[0].kind, "report");
    assert.equal(items[0].source, "scheduled-task");
    assert.equal(items[0].telegram?.status, "sent");
    assert.ok(requests[0].reply_markup);
    assert.notEqual(requests[0].text, items[0].body);
    const failed = createRunTaskCommand(createCliRuntime(root), {
      run: () => Promise.reject(new Error("provider unavailable")),
    });
    await assert.rejects(failed(["Исследуй тему"]), /provider unavailable/u);
    const notices = await listNotifications();
    assert.equal(notices[0].kind, "alert");
    assert.equal(notices.filter((n) => n.kind === "reminder").length, 0);
    assert.equal(notices.filter((n) => n.kind === "report").length, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (before === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = before;
    if (url === undefined) delete process.env.LIBRECHAT_PUBLIC_URL;
    else process.env.LIBRECHAT_PUBLIC_URL = url;
    await rm(root, { recursive: true, force: true });
  }
});
