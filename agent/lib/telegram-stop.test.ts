/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import { handleTelegramStopCallback } from "./telegram-stop.ts";

test("one admitted private user cannot cancel another admitted user's turn", async () => {
  const acknowledgements: Array<string | undefined> = [];
  let cancelled = 0;
  const outcome = await handleTelegramStopCallback(
    {
      id: "callback",
      data: "iva:stop",
      from: { id: 202 },
      message: { chat: { id: 101, type: "private" } },
    },
    {
      ackImpl: (text) => {
        acknowledgements.push(text);
        return Promise.resolve();
      },
      allowedImpl: () => new Set(["101", "202"]),
      runningImpl: () => true,
      getStatusImpl: () => ({
        status: "running",
        continuationToken: "tenant-a-token",
      }),
      cancelImpl: () => {
        cancelled += 1;
        return Promise.resolve();
      },
      secret: "secret",
    },
  );
  assert.equal(outcome, "ignored");
  assert.equal(acknowledgements.length, 1);
  assert.equal(cancelled, 0);
});
