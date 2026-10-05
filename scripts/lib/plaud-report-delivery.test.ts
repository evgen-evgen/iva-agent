/* eslint-disable @typescript-eslint/require-await -- Async doubles follow fetch contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishPlaud,
  pendingPlaud,
  plaudKey,
  readPlaudAnalysis,
  readPlaudSnapshot,
  savePlaudSnapshot,
} from "#lib/plaud-import.ts";
import {
  createNotification,
  getNotification,
  listNotifications,
  pendingReportNotifications,
} from "#lib/notification-store.ts";
import { deliverPlaudReports } from "./plaud-report-delivery.ts";

void test("Plaud finish archives one report; failed notification retries without reprocessing the meeting", async () => {
  const original = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "iva-plaud-notice-"));
  process.env.ASSISTANT_DATA_DIR = join(root, "data");
  process.env.LIBRECHAT_PUBLIC_URL = "https://libre.example.com/";
  process.env.TELEGRAM_BOT_TOKEN = "bot";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "9";
  process.env.TELEGRAM_ENABLED = "true";
  process.env.AGENT_LANGUAGE = "ru";
  delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
  delete process.env.IVA_METADATA_DATABASE_URL;
  try {
    const source = {
      account: "ceo",
      fileId: "meeting",
      metadata: { name: "Budget" },
      transcript: [{ text: "Discuss the budget" }],
      notes: [],
    };
    const archive = join(root, "plaud");
    const key = plaudKey(source.account, source.fileId);
    await savePlaudSnapshot(archive, source);
    assert.equal((await listNotifications()).length, 0);
    const snapshot = await readPlaudSnapshot(archive, key);
    const report = "Budget reviewed; CEO should approve the plan";
    await finishPlaud(archive, key, snapshot.revision, report, [
      "cards/meetings/budget.md",
    ]);
    assert.equal((await pendingPlaud(archive)).length, 0);
    const [notification] = await listNotifications();
    assert.equal(notification.kind, "report");
    assert.equal(notification.title, "Встреча Plaud: Budget");
    assert.equal(notification.body, report);
    assert.equal(
      ((await readPlaudAnalysis(archive, key)) as { reportId: string })
        .reportId,
      notification.id,
    );
    await finishPlaud(
      archive,
      key,
      snapshot.revision,
      "Must preserve original",
      [],
    );
    assert.equal((await listNotifications()).length, 1);
    assert.equal((await getNotification(notification.id))?.body, report);

    const other = await createNotification({
      body: "Other account",
      kind: "report",
      source: "plaud:other:key",
    });
    const requests: Record<string, unknown>[] = [];
    let fail = true;
    const fetchImpl: typeof fetch = async (_url, options) => {
      requests.push(
        JSON.parse(options!.body as string) as Record<string, unknown>,
      );
      return fail
        ? new Response('{"ok":false,"description":"Unavailable"}', {
            status: 503,
          })
        : new Response('{"ok":true}', { status: 200 });
    };
    assert.deepEqual(await deliverPlaudReports("ceo", { fetchImpl }), {
      sent: 0,
      errors: 1,
    });
    assert.equal(
      (await getNotification(notification.id))?.telegram?.status,
      "failed",
    );
    assert.equal((await pendingPlaud(archive)).length, 0);
    assert.equal((await pendingReportNotifications("plaud:ceo:")).length, 1);
    assert.equal((await getNotification(other.id))?.telegram, undefined);
    fail = false;
    const beforeConcurrentSend = requests.length;
    const deliveries = await Promise.all([
      deliverPlaudReports("ceo", { fetchImpl }),
      deliverPlaudReports("ceo", { fetchImpl }),
    ]);
    assert.equal(
      deliveries.reduce((total, delivery) => total + delivery.sent, 0),
      1,
    );
    assert.ok(deliveries.every((delivery) => delivery.errors === 0));
    assert.equal(requests.length, beforeConcurrentSend + 1);
    const sent = requests.at(-1)!;
    assert.equal(sent.text, "Разбор встречи Plaud готов.");
    assert.equal(sent.chat_id, "9");
    const markup = sent.reply_markup as {
      inline_keyboard: { url?: string; callback_data?: string }[][];
    };
    assert.equal(
      new URL(markup.inline_keyboard[0][0].url!).searchParams.get("iva_report"),
      notification.id,
    );
    assert.equal(
      markup.inline_keyboard[0][1].callback_data,
      `iva_report:${notification.id}`,
    );
    const requestCount = requests.length;
    assert.deepEqual(await deliverPlaudReports("ceo", { fetchImpl }), {
      sent: 0,
      errors: 0,
    });
    assert.equal(requests.length, requestCount);

    // Each edited revision has its own report, while old reports remain accessible.
    await savePlaudSnapshot(archive, {
      ...source,
      transcript: [{ text: "Budget changed" }],
    });
    const edited = await readPlaudSnapshot(archive, key);
    await finishPlaud(archive, key, edited.revision, "Revised report", []);
    assert.equal((await pendingReportNotifications("plaud:ceo:")).length, 1);
    assert.equal((await getNotification(notification.id))?.body, report);
    delete process.env.TELEGRAM_BOT_TOKEN;
    assert.deepEqual(await deliverPlaudReports("ceo", { fetchImpl }), {
      sent: 0,
      errors: 0,
    });
    assert.equal((await pendingReportNotifications("plaud:ceo:")).length, 0);
    assert.equal(requests.length, requestCount);
  } finally {
    for (const name of [
      "ASSISTANT_DATA_DIR",
      "LIBRECHAT_PUBLIC_URL",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_NOTIFICATION_CHAT_ID",
      "TELEGRAM_ENABLED",
      "AGENT_LANGUAGE",
      "LIBRECHAT_NOTIFICATION_SECRET",
      "IVA_METADATA_DATABASE_URL",
    ]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});
