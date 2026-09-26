// The opt-in in-process eve schedule in agent/schedules/digest.ts asks the agent for a
// morning digest and sends it to Telegram. It is disabled by default in data/settings.json.
//
// Requires: a running agent (eve start) and the TELEGRAM_BOT_TOKEN, TELEGRAM_NOTIFICATION_CHAT_ID variables.
import { Client } from "eve/client";
import { tr } from "#lib/i18n.ts";
import { writtenInLanguage } from "./lib/notice-policy.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { telegramEnabled } from "#lib/feature-flags.ts";
import {
  createNotification,
  setNotificationTelegramDelivery,
} from "#lib/notification-store.ts";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the eve channel in prod requires auth

if (!telegramEnabled()) {
  console.log("digest: Telegram disabled; nothing to send");
  process.exit(0);
}

if (!BOT || !CHAT) {
  console.error(
    "TELEGRAM_BOT_TOKEN and TELEGRAM_NOTIFICATION_CHAT_ID are required",
  );
  process.exit(1);
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

const session = client.session();
// The same delivery rule the nightly rollup states, in the same words: this turn's result
// is delivered by the code below, so a rich message here would be the second message.
// The red line in agent/instructions.md exempts exactly these two scheduled turns.
const response = await session.send(
  "Load the morning-digest skill and build the morning digest for my tasks. " +
    `Return the digest ${writtenInLanguage(tr)}. ` +
    "Return the digest as the final text of this turn. Do not send it anywhere yourself: " +
    "no rich messages, no digest chat, no Telegram tools. " +
    "Only the finished digest text, no preamble.",
);
const result = await response.result();

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we key off the presence of text rather than the "completed" status.
if (result.status === "failed" || !result.message) {
  console.error("Agent did not return a digest:", result.status);
  process.exit(1);
}

// The markdown → Telegram-HTML conversion + self-heal live in a shared helper.
// Ночной ход зовётся своим именем и сшивается по сессии: журнал хода (ADR-0010).
const notification = await createNotification({
  body: result.message,
  kind: "report",
  source: "morning-digest",
  title: "Утренний дайджест",
});
const r = await sendTelegramHtml(BOT, CHAT, result.message, {
  trace: { session: response.sessionId, source: "digest" },
});
await setNotificationTelegramDelivery(
  notification.id,
  r.ok ? "sent" : "failed",
  r.ok ? undefined : r.error,
).catch((error: unknown) =>
  console.error("digest: notification delivery status was not saved:", error),
);
if (r.fellBack) {
  await session.send(
    `The last digest failed Telegram parse_mode=HTML (${r.error}) and was sent as plain text — ` +
      "format more simply next time: **bold**, `code`, lists, no raw HTML.",
  );
}
if (!r.ok) {
  console.error("digest: Telegram send failed:", r.error);
  process.exit(1);
}
console.log("Digest sent to Telegram.");
