import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
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

const MAX_NOTIFICATIONS = 500;
const EMPTY: NotificationFile = { version: 1, notifications: [] };

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
      notifications: mutate(current.notifications).slice(-MAX_NOTIFICATIONS),
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
}): Promise<IvaNotification> {
  const body = input.body.trim();
  if (!body) throw new Error("notification body is empty");
  const firstLine =
    body
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? body;
  const notification: IvaNotification = {
    id: randomUUID(),
    kind: input.kind ?? "notice",
    title: input.title?.trim() || firstLine.slice(0, 100),
    body,
    createdAt: new Date().toISOString(),
    ...(input.source ? { source: input.source } : {}),
  };
  await update((items) => [...items, notification]);
  return notification;
}

export async function listNotifications(
  limit = 100,
): Promise<IvaNotification[]> {
  const { file } = paths();
  const current = await loadJsonStrict<NotificationFile>(file, EMPTY);
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 100, 200));
  return current.notifications.slice(-bounded).reverse();
}

export async function markNotificationRead(id?: string): Promise<number> {
  let changed = 0;
  const readAt = new Date().toISOString();
  await update((items) =>
    items.map((item) => {
      if (item.readAt || (id && item.id !== id)) return item;
      changed++;
      return { ...item, readAt };
    }),
  );
  return changed;
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
