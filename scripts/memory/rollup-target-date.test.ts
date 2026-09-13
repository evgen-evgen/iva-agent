/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDailyTargetDate, shiftIsoDate } from "./rollup-target-date.ts";

test("daily rollup defaults to the previous completed day", () => {
  assert.equal(resolveDailyTargetDate("daily", [], "2026-09-13"), "2026-09-12");
  assert.equal(shiftIsoDate("2026-03-01", -1), "2026-02-28");
});

test("daily rollup accepts one explicit historical target date", () => {
  assert.equal(
    resolveDailyTargetDate(
      "daily",
      ["--target-date", "2026-09-07"],
      "2026-09-13",
    ),
    "2026-09-07",
  );
});

test("target date fails closed for invalid, future, duplicate, and non-daily use", () => {
  assert.throws(
    () =>
      resolveDailyTargetDate(
        "daily",
        ["--target-date", "2026-02-30"],
        "2026-09-13",
      ),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () =>
      resolveDailyTargetDate(
        "daily",
        ["--target-date", "2026-09-13"],
        "2026-09-13",
      ),
    /completed day/,
  );
  assert.throws(
    () =>
      resolveDailyTargetDate(
        "daily",
        ["--target-date", "2026-09-07", "--target-date", "2026-09-08"],
        "2026-09-13",
      ),
    /only once/,
  );
  assert.throws(
    () =>
      resolveDailyTargetDate(
        "weekly",
        ["--target-date", "2026-09-07"],
        "2026-09-13",
      ),
    /only for the daily/,
  );
});
