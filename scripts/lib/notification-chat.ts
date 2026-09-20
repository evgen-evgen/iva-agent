import { telegramEnabled } from "#lib/feature-flags.ts";

export function notificationChat(
  env: Record<string, string | undefined> = process.env,
): string {
  if (!telegramEnabled(env)) return "";
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  if (digest) return digest;
  return (
    String(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .find(Boolean) ?? ""
  );
}
