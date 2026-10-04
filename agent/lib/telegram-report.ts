import { getNotification } from "./notification-store.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { isPrivateTelegramChat } from "./telegram-private-chat.ts";
import { redactNotice } from "./outbox.ts";
import { tr } from "./i18n.ts";

export const REPORT_CALLBACK_PREFIX = "iva_report:";
type ReportCallback = {
  id: string;
  data?: string;
  from?: { id?: string | number };
  message?: { chat?: { id?: string | number; type?: string } };
};

// Shared by polling and webhooks. Never reveal reports to foreign users or groups.
export async function handleTelegramReportCallback(
  query: ReportCallback,
  io: {
    ack: (text?: string) => Promise<unknown>;
    send: (chat: string, body: string) => Promise<boolean>;
  },
): Promise<boolean> {
  if (!query.data?.startsWith(REPORT_CALLBACK_PREFIX)) return false;
  const chat = query.message?.chat;
  if (
    !allowedTelegramUsers().has(String(query.from?.id ?? "")) ||
    !isPrivateTelegramChat(chat) ||
    chat?.id === undefined
  ) {
    await io.ack().catch(() => {});
    return true;
  }
  const id = query.data.slice(REPORT_CALLBACK_PREFIX.length);
  const report = /^[a-f0-9-]{36}$/u.test(id)
    ? await getNotification(id)
    : undefined;
  if (!report || report.kind !== "report") {
    await io.ack(tr("Report not found.", "Отчёт не найден.")).catch(() => {});
    return true;
  }
  await io.ack().catch(() => {});
  const sent = await io.send(String(chat.id), redactNotice(report.body));
  if (!sent) throw new Error("Telegram report delivery failed");
  return true;
}
