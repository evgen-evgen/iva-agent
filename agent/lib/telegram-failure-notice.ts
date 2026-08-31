// Сообщение о падении хода. У terminal-сбоя eve присылает и turn.failed, и
// session.failed — оба несут одну и ту же беду, но пользователь должен увидеть её
// один раз. Заявка на уведомление берётся по sessionId и живёт TTL; не ушедшее
// сообщение освобождает заявку, чтобы следующее событие всё-таки объяснило сбой.
//
// Это служебная реплика канала, а не текст модели: мимо Outbox, но не мимо гейта —
// текст провайдера и errorId здесь runtime-контент. Отправку модуль поэтому просит
// брендованную (NoticeSend): гейт стоит на вызове Bot API, а не тут (правило в outbox.ts).
import { humanizeProviderError } from "./error-humanizer.ts";
import { tr } from "./i18n.ts";
import type { NoticeSend } from "./outbox.ts";

export type TelegramFailureData = {
  message: string;
  code?: unknown;
  details?: unknown;
  turnId?: unknown;
};

const FAILURE_NOTIFICATION_TTL_MS = 60_000;
const failureNotifications = new Map<string, number>();

function pruneFailureNotifications(now: number): void {
  for (const [sessionId, notifiedAt] of failureNotifications) {
    if (now - notifiedAt >= FAILURE_NOTIFICATION_TTL_MS) {
      failureNotifications.delete(sessionId);
    }
  }
}

function claimFailureNotification(
  sessionId: string,
  now: number,
): number | null {
  pruneFailureNotifications(now);
  const notifiedAt = failureNotifications.get(sessionId);
  if (
    notifiedAt !== undefined &&
    now - notifiedAt < FAILURE_NOTIFICATION_TTL_MS
  ) {
    return null;
  }
  failureNotifications.set(sessionId, now);
  return now;
}

function releaseFailureNotification(sessionId: string, claim: number): void {
  if (failureNotifications.get(sessionId) === claim) {
    failureNotifications.delete(sessionId);
  }
}

function extractFailureErrorId(details: unknown): string | undefined {
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const errorId = (details as Record<string, unknown>).errorId;
  return typeof errorId === "string" && errorId.length > 0
    ? errorId
    : undefined;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Safe end-user copy: never includes provider text, ids, stack traces or details. */
export function telegramFailureUserMessage(): string {
  return tr(
    "I couldn't complete the request, so the current process was stopped. Please try again or start a new dialog with /new.",
    "Не удалось выполнить запрос, поэтому текущий процесс остановлен. Попробуйте ещё раз или начните новый диалог командой /new.",
  );
}

/** Technical copy for the explicitly configured private diagnostics channel. */
export function telegramFailureDiagnosticMessage(
  sessionId: string,
  data: TelegramFailureData,
): string {
  const text = humanizeProviderError(data);
  const errorId = extractFailureErrorId(data.details);
  const code = bounded(
    typeof data.code === "string" ? data.code : "unknown",
    160,
  );
  const turnId = bounded(
    typeof data.turnId === "string" ? data.turnId : "unknown",
    200,
  );
  return [
    "🚨 Telegram turn failed",
    `Session: ${bounded(sessionId, 200)}`,
    `Turn: ${turnId}`,
    `Code: ${code}`,
    ...(errorId ? [`Error id: ${bounded(errorId, 300)}`] : []),
    "",
    tr(text.en, text.ru),
    "",
    `Raw: ${bounded(data.message || "<empty>", 2_000)}`,
  ].join("\n");
}

/** @deprecated User-facing failures are deliberately generic. */
export function telegramFailureMessage(
  _data?: TelegramFailureData,
): string {
  void _data;
  return telegramFailureUserMessage();
}

// Отправляет объяснение сбоя ровно один раз на сессию. Сбой самой отправки
// глотаем: сообщение об ошибке не повод рушить обработчик события.
export async function notifyTelegramFailure(
  sessionId: string,
  data: TelegramFailureData,
  send: NoticeSend,
  {
    now = Date.now(),
    diagnosticSend,
  }: { now?: number; diagnosticSend?: NoticeSend } = {},
): Promise<void> {
  const userClaim = claimFailureNotification(`${sessionId}:user`, now);
  if (userClaim !== null) {
    try {
      await send(telegramFailureUserMessage());
    } catch {
      releaseFailureNotification(`${sessionId}:user`, userClaim);
      /* молча игнорируем сбой ответа */
    }
  }
  if (diagnosticSend !== undefined) {
    const diagnosticClaim = claimFailureNotification(
      `${sessionId}:diagnostic`,
      now,
    );
    if (diagnosticClaim === null) return;
    try {
      await diagnosticSend(telegramFailureDiagnosticMessage(sessionId, data));
    } catch {
      releaseFailureNotification(`${sessionId}:diagnostic`, diagnosticClaim);
      /* журнал остаётся источником деталей, если Telegram-канал недоступен */
    }
  }
}
