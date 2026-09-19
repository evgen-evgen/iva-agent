/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { retireMemoryEvalSession } from "./eval-session.ts";

test("benchmark session retirement resets Eve and removes its cursor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "iva-eval-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "rollup-session-daily.json");
  writeFileSync(cursorPath, "{}\n");
  let resets = 0;

  const retired = await retireMemoryEvalSession({
    enabled: true,
    session: {
      reset: () => {
        resets += 1;
        return Promise.resolve({ status: "reset" });
      },
    },
    cursorPath,
  });

  assert.equal(retired, true);
  assert.equal(resets, 1);
  assert.equal(existsSync(cursorPath), false);
});

test("production session retirement is a no-op", async () => {
  let resets = 0;
  const retired = await retireMemoryEvalSession({
    enabled: false,
    session: {
      reset: () => {
        resets += 1;
        return Promise.resolve({ status: "reset" });
      },
    },
  });

  assert.equal(retired, false);
  assert.equal(resets, 0);
});

test("unexpected reset status fails closed", async () => {
  await assert.rejects(
    retireMemoryEvalSession({
      enabled: true,
      session: {
        reset: () => Promise.resolve({ status: "accepted" }),
      },
    }),
    /Unexpected Eve session reset status/,
  );
});
