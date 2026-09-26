import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticChat, notificationChat } from "./notification-chat.ts";

void test("notification chat uses only its explicit destination", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_NOTIFICATION_CHAT_ID: "99",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
    }),
    "99",
  );
});

void test("notification chat does not infer a destination from the inbound allowlist", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_NOTIFICATION_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: " 1, 2",
    }),
    "",
  );
});

void test("notification chat is empty without an explicit destination", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_NOTIFICATION_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: "",
    }),
    "",
  );
});

void test("notification chat is empty when Telegram is disabled", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_ENABLED: "false",
      TELEGRAM_NOTIFICATION_CHAT_ID: "99",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
    }),
    "",
  );
});

void test("diagnostic alerts use only the explicit diagnostic channel", () => {
  assert.equal(
    diagnosticChat({
      TELEGRAM_DIAGNOSTIC_CHAT_ID: "-10099",
      TELEGRAM_NOTIFICATION_CHAT_ID: "42",
    }),
    "-10099",
  );
  assert.equal(diagnosticChat({ TELEGRAM_NOTIFICATION_CHAT_ID: "42" }), "");
});
