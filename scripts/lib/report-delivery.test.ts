/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement production Promise contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendReportReady, reportLink } from "./report-delivery.ts";
import { createNotification } from "#lib/notification-store.ts";
import { handleTelegramReportCallback } from "#lib/telegram-report.ts";

void test("Telegram sends only the ready notice, links the archived report, and reveals it only on an authorized tap", async () => {
  const original = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), "iva-report-delivery-"));
  process.env.ASSISTANT_DATA_DIR = directory;
  process.env.LIBRECHAT_PUBLIC_URL = "https://libre.example.com/";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
  process.env.AGENT_LANGUAGE = "ru";
  try {
    const report = await createNotification({
      body: "Полный отчёт и план действий",
      kind: "report",
      source: "morning-digest",
    });
    const requests: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, options) => {
      assert.equal(typeof options?.body, "string");
      requests.push(
        JSON.parse(options!.body as string) as Record<string, unknown>,
      );
      return new Response("{}", { status: 200 });
    };
    assert.ok((await sendReportReady("bot", "9", report, { fetchImpl })).ok);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, "Отчёт и план готовы.");
    const markup = requests[0].reply_markup as {
      inline_keyboard: {
        text: string;
        url?: string;
        callback_data?: string;
      }[][];
    };
    assert.equal(markup.inline_keyboard[0][0].text, "Открыть в Libre");
    assert.equal(
      new URL(markup.inline_keyboard[0][0].url!).searchParams.get("iva_report"),
      report.id,
    );
    assert.equal(
      markup.inline_keyboard[0][1].callback_data,
      `iva_report:${report.id}`,
    );
    assert.ok(
      Buffer.byteLength(markup.inline_keyboard[0][1].callback_data) <= 64,
    );
    const shown: string[] = [];
    const io = {
      ack: async () => {},
      send: async (_chat: string, body: string) => {
        shown.push(body);
        return true;
      },
    };
    const query = {
      id: "callback",
      data: `iva_report:${report.id}`,
      from: { id: 9 },
      message: { chat: { id: 9, type: "private" } },
    };
    await handleTelegramReportCallback({ ...query, from: { id: 10 } }, io);
    await handleTelegramReportCallback(
      { ...query, message: { chat: { id: -1, type: "group" } } },
      io,
    );
    assert.equal(shown.length, 0);
    await handleTelegramReportCallback(query, io);
    assert.deepEqual(shown, [report.body]);
    await handleTelegramReportCallback(
      { ...query, data: "iva_report:../../private" },
      io,
    );
    assert.equal(shown.length, 1);
    await assert.rejects(
      handleTelegramReportCallback(query, { ...io, send: async () => false }),
    );
    delete process.env.LIBRECHAT_PUBLIC_URL;
    assert.throws(() => reportLink(report.id), /LIBRECHAT_PUBLIC_URL/u);
    assert.equal(
      (await sendReportReady("bot", "9", report, { fetchImpl })).ok,
      false,
    );
    assert.equal(requests.length, 1);
  } finally {
    for (const name of [
      "ASSISTANT_DATA_DIR",
      "LIBRECHAT_PUBLIC_URL",
      "TELEGRAM_ALLOWED_USER_IDS",
      "AGENT_LANGUAGE",
    ]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
