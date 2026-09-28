import assert from "node:assert/strict";
import test from "node:test";
import { envFlag, telegramEnabled } from "./feature-flags.ts";

test("feature flags keep backwards-compatible defaults", () => {
  assert.equal(envFlag(undefined), true);
  assert.equal(telegramEnabled({}), true);
});

test("Telegram can be explicitly disabled", () => {
  for (const value of ["false", "0", "no", "off", "disabled", " FALSE "])
    assert.equal(telegramEnabled({ TELEGRAM_ENABLED: value }), false);
});

test("recognized true values enable Telegram", () => {
  for (const value of ["true", "1", "yes", "on", "enabled"])
    assert.equal(telegramEnabled({ TELEGRAM_ENABLED: value }), true);
});
