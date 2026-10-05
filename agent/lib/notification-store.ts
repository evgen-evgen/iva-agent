import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { syncLibreChatReports } from "./librechat-report-sync.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";

export type NotificationKind = "alert" | "notice" | "reminder" | "report";
export type NotificationDeliveryStatus = "failed" | "sent" | "skipped";

export type IvaNotification = {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly source?: string;
  readonly readAt?: string;
  readonly readBy?: Readonly<Record<string, string>>;
  readonly telegram?: {
    readonly status: NotificationDeliveryStatus;
    readonly at: string;
    readonly error?: string;
  };
};

type NotificationFile = {
  readonly version: 1;
  readonly notifications: IvaNotification[];
};

const EMPTY: NotificationFile = { version: 1, notifications: [] };

export function notificationIdForKey(idempotencyKey: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function paths() {
  const file = join(dataDir(), "notifications.json");
  return { file, lock: `${file}.lock` };
}

async function update(
  mutate: (items: IvaNotification[]) => IvaNotification[],
): Promise<NotificationFile> {
  const { file, lock } = paths();
  const token = await acquireLock(lock);
  try {
    const current = await loadJsonStrict<NotificationFile>(file, EMPTY);
    const next = {
      version: 1 as const,
      // This is also the report archive. Pagination limits the UI, not retention.
      notifications: mutate(current.notifications),
    };
    await saveJsonAtomic(file, next);
    return next;
  } finally {
    releaseLock(lock, token);
  }
}

export async function createNotification(input: {
  readonly body: string;
  readonly kind?: NotificationKind;
  readonly source?: string;
  readonly title?: string;
  readonly idempotencyKey?: string;
}): Promise<IvaNotification> {
  const body = input.body.trim();
  if (!body) throw new Error("notification body is empty");
  const firstLine =
    body
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? body;
  let notification: IvaNotification = {
    id: input.idempotencyKey
      ? notificationIdForKey(input.idempotencyKey)
      : randomUUID(),
    kind: input.kind ?? "notice",
    title: input.title?.trim() || firstLine.slice(0, 100),
    body,
    createdAt: new Date().toISOString(),
    ...(input.source ? { source: input.source } : {}),
  };
  await update((items) => {
    const existing = items.find((item) => item.id === notification.id);
    if (existing) {
      notification = existing;
      return items;
    }
    return [...items, notification];
  });
  if (notification.kind === "report") await syncLibreChatReports();
  return notification;
}

export async function listNotifications(
  limit = 100,
  offset = 0,
): Promise<IvaNotification[]> {
  const { file } = paths();
  const current = await loadJsonStrict<NotificationFile>(file, EMPTY);
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 100, 200));
  const start = Math.max(0, Math.trunc(offset) || 0);
  return current.notifications
    .slice()
    .reverse()
    .slice(start, start + bounded);
}

export async function getNotification(
  id: string,
): Promise<IvaNotification | undefined> {
  return (await getNotifications([id]))[0];
}

export async function getNotifications(
  ids: readonly string[],
): Promise<IvaNotification[]> {
  const selected = new Set(ids);
  const current = await loadJsonStrict<NotificationFile>(paths().file, EMPTY);
  return current.notifications.filter((item) => selected.has(item.id));
}

export async function pendingReportNotifications(
  sourcePrefix: string,
): Promise<IvaNotification[]> {
  const current = await loadJsonStrict<NotificationFile>(paths().file, EMPTY);
  return current.notifications.filter(
    (item) =>
      item.kind === "report" &&
      item.source?.startsWith(sourcePrefix) &&
      item.telegram?.status !== "sent" &&
      item.telegram?.status !== "skipped",
  );
}

export async function unreadNotificationCount(
  principalId: string,
): Promise<number> {
  const current = await loadJsonStrict<NotificationFile>(paths().file, EMPTY);
  return current.notifications.filter((item) => !item.readBy?.[principalId])
    .length;
}

export async function markNotificationRead(
  id?: string,
  principalId?: string,
): Promise<number> {
  let changed = 0;
  const readAt = new Date().toISOString();
  await update((items) =>
    items.map((item) => {
      if (id && item.id !== id) return item;
      if (principalId) {
        if (item.readBy?.[principalId]) return item;
        changed++;
        return {
          ...item,
          readBy: { ...item.readBy, [principalId]: readAt },
        };
      }
      if (item.readAt) return item;
      changed++;
      return { ...item, readAt };
    }),
  );
  return changed;
}

export function notificationForPrincipal(
  item: IvaNotification,
  principalId: string,
): IvaNotification {
  const readAt = item.readBy?.[principalId];
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    ...(item.source ? { source: item.source } : {}),
    ...(readAt ? { readAt } : {}),
    ...(item.telegram ? { telegram: item.telegram } : {}),
  };
}

export async function setNotificationTelegramDelivery(
  id: string,
  status: NotificationDeliveryStatus,
  error?: string,
): Promise<void> {
  const at = new Date().toISOString();
  await update((items) =>
    items.map((item) =>
      item.id === id
        ? {
            ...item,
            telegram: {
              status,
              at,
              ...(error ? { error: error.slice(0, 500) } : {}),
            },
          }
        : item,
    ),
  );
}
