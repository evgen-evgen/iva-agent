import type { IvaNotification } from "#lib/notification-store.ts";
import { tr } from "#lib/i18n.ts";
import { sendTelegramHtml, type TelegramSendOptions } from "./telegram-send.ts";

export function reportLink(id: string): string {
  const configured = process.env.LIBRECHAT_PUBLIC_URL?.trim();
  if (!configured)
    throw new Error(
      "Set LIBRECHAT_PUBLIC_URL to the browser-accessible LibreChat address for report links",
    );
  const url = new URL(configured);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "LIBRECHAT_PUBLIC_URL must be an HTTP(S) address without credentials",
    );
  }
  url.searchParams.set("iva_report", id);
  return url.toString();
}

export async function sendReportReady(
  bot: string,
  chat: string,
  report: IvaNotification,
  options: TelegramSendOptions = {},
): ReturnType<typeof sendTelegramHtml> {
  try {
    const morning = report.source === "morning-digest";
    return await sendTelegramHtml(
      bot,
      chat,
      morning
        ? tr("Your report and plan are ready.", "Отчёт и план готовы.")
        : tr("Your report is ready.", "Отчёт готов."),
      {
        ...options,
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: tr("Open in Libre", "Открыть в Libre"),
                url: reportLink(report.id),
              },
              {
                text: tr("Show here", "Показать тут"),
                callback_data: `iva_report:${report.id}`,
              },
            ],
          ],
        },
      },
    );
  } catch (error) {
    return {
      ok: false,
      fellBack: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
