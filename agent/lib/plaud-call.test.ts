/* eslint-disable @typescript-eslint/no-floating-promises -- Node test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { limitPlaudCalls } from "./plaud-call.ts";
import { PlaudRateLimitError } from "./plaud-import.ts";

test("concurrent requests are paced and explicit rate limits back off before retry", async () => {
  let time = 0;
  const starts: { name: string; at: number }[] = [];
  let limited = true;
  const call = limitPlaudCalls(
    (name) => {
      starts.push({ name, at: time });
      if (limited) {
        limited = false;
        return Promise.reject(new PlaudRateLimitError());
      }
      return Promise.resolve(name);
    },
    {
      now: () => time,
      wait: (ms) => {
        time += ms;
        return Promise.resolve();
      },
    },
  );
  assert.deepEqual(await Promise.all([call("first", {}), call("second", {})]), [
    "first",
    "second",
  ]);
  assert.deepEqual(starts, [
    { name: "first", at: 0 },
    { name: "first", at: 15_000 },
    { name: "second", at: 17_000 },
  ]);
});

test("retries are bounded, authentication failures are not retried, and later calls remain usable", async () => {
  let attempts = 0;
  const waits: number[] = [];
  let time = 0;
  const call = limitPlaudCalls(
    (name) => {
      attempts++;
      if (name === "limited") return Promise.reject(new PlaudRateLimitError());
      if (name === "auth")
        return Promise.reject(new Error("not authenticated"));
      return Promise.resolve(true);
    },
    {
      now: () => time,
      wait: (ms) => {
        waits.push(ms);
        time += ms;
        return Promise.resolve();
      },
    },
  );
  await assert.rejects(call("limited", {}), PlaudRateLimitError);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [15_000, 30_000, 60_000]);
  await assert.rejects(call("auth", {}), /not authenticated/);
  assert.equal(attempts, 5);
  assert.equal(await call("healthy", {}), true);
  assert.equal(attempts, 6);
});
