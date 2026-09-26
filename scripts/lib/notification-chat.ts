import { telegramEnabled } from "#lib/feature-flags.ts";

export function notificationChat(
  env: Record<string, string | undefined> = process.env,
): string {
  if (!telegramEnabled(env)) return "";
  return String(env.TELEGRAM_NOTIFICATION_CHAT_ID ?? "").trim();
}

/** Operational failures go to a separate admin channel, never to the user inbox. */
export function diagnosticChat(
  env: Record<string, string | undefined> = process.env,
): string {
  if (!telegramEnabled(env)) return "";
  return String(env.TELEGRAM_DIAGNOSTIC_CHAT_ID ?? "").trim();
}
