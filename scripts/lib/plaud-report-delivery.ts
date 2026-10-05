import { telegramEnabled } from "#lib/feature-flags.ts";
import { join } from "node:path";
import { dataDir } from "#lib/data-dir.ts";
import { acquireFileLock, releaseFileLock } from "#lib/fs-atomic.ts";
import {
  getNotification,
  pendingReportNotifications,
  setNotificationTelegramDelivery,
} from "#lib/notification-store.ts";
import { sendReportReady } from "./report-delivery.ts";
import type { TelegramSendOptions } from "./telegram-send.ts";

export async function deliverPlaudReports(
  account: string,
  options: TelegramSendOptions = {},
) {
  const queued = await pendingReportNotifications(`plaud:${account}:`);
  let sent = 0;
  let errors = 0;
  for (const notification of queued) {
    const lock = await acquireFileLock(
      join(dataDir(), `plaud-delivery-${notification.id}.lock`),
      { timeoutMs: 1000, staleMs: 5 * 60_000 },
    );
    if (!lock) continue;
    try {
      const current = await getNotification(notification.id);
      if (
        !current ||
        current.telegram?.status === "sent" ||
        current.telegram?.status === "skipped"
      )
        continue;
      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
      if (!telegramEnabled() || !bot || !chat) {
        await setNotificationTelegramDelivery(notification.id, "skipped");
        continue;
      }
      const result = await sendReportReady(bot, chat, notification, options);
      await setNotificationTelegramDelivery(
        notification.id,
        result.ok ? "sent" : "failed",
        result.ok ? undefined : result.error,
      );
      if (result.ok) sent++;
      else errors++;
    } finally {
      releaseFileLock(lock);
    }
  }
  return { sent, errors };
}
