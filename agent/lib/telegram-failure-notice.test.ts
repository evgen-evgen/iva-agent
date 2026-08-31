import test from "node:test";
import assert from "node:assert/strict";
import { noticeSender } from "./outbox.ts";
import {
  notifyTelegramFailure,
  telegramFailureDiagnosticMessage,
  telegramFailureUserMessage,
} from "./telegram-failure-notice.ts";

function collector() {
  const sent: string[] = [];
  return {
    sent,
    send: noticeSender((text: string) => {
      sent.push(text);
      return Promise.resolve(null);
    }),
  };
}

await test("user failure copy contains no technical details", () => {
  const text = telegramFailureUserMessage();
  assert.match(text, /stopped|остановлен/u);
  assert.match(text, /\/new/u);
  assert.doesNotMatch(text, /provider|error id|session|stack/iu);
});

await test("technical copy is reserved for diagnostics", () => {
  const text = telegramFailureDiagnosticMessage("session-77", {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err-77" },
    message: "provider exploded",
    turnId: "turn-77",
  });
  assert.match(text, /Session: session-77/u);
  assert.match(text, /Turn: turn-77/u);
  assert.match(text, /Code: MODEL_CALL_FAILED/u);
  assert.match(text, /Error id: err-77/u);
  assert.match(text, /provider exploded/u);
});

await test("turn.failed and session.failed notify each audience once", async () => {
  const user = collector();
  const diagnostic = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-1", data, user.send, {
    now: 1_000,
    diagnosticSend: diagnostic.send,
  });
  await notifyTelegramFailure("s-1", data, user.send, {
    now: 1_050,
    diagnosticSend: diagnostic.send,
  });

  assert.deepEqual(user.sent, [telegramFailureUserMessage()]);
  assert.equal(diagnostic.sent.length, 1);
  assert.match(diagnostic.sent[0], /provider exploded/u);
});

await test("audience claims recover independently after a send failure", async () => {
  const user = collector();
  const diagnostic = collector();
  const failed = noticeSender(() => Promise.reject(new Error("Telegram 502")));

  await notifyTelegramFailure("s-retry", { message: "boom" }, failed, {
    now: 1_000,
    diagnosticSend: diagnostic.send,
  });
  await notifyTelegramFailure("s-retry", { message: "boom" }, user.send, {
    now: 1_100,
    diagnosticSend: diagnostic.send,
  });

  assert.equal(user.sent.length, 1);
  assert.equal(diagnostic.sent.length, 1);
});

await test("diagnostic secrets are redacted before Telegram transport", async (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const user = collector();
  const diagnostic = collector();
  const planted = `api_key=${"z".repeat(24)}`;

  await notifyTelegramFailure(
    "s-secret",
    {
      message: `Incorrect API key provided: ${planted}`,
      details: { errorId: planted },
    },
    user.send,
    { now: 1_000, diagnosticSend: diagnostic.send },
  );

  assert.equal(user.sent.length, 1);
  assert.doesNotMatch(user.sent[0], /zzzz|REDACTED/u);
  assert.equal(diagnostic.sent.length, 1);
  assert.doesNotMatch(diagnostic.sent[0], /zzzz/u);
  assert.match(diagnostic.sent[0], /\[REDACTED\]/u);
});

await test("diagnostics remain optional", async () => {
  const user = collector();
  await notifyTelegramFailure("s-no-diagnostic", { message: "boom" }, user.send, {
    now: 1_000,
  });
  assert.deepEqual(user.sent, [telegramFailureUserMessage()]);
});
