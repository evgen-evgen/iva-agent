import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNotification,
  listNotifications,
  markNotificationRead,
  notificationForPrincipal,
  setNotificationTelegramDelivery,
} from "./notification-store.ts";

void test("notification inbox persists, orders and acknowledges entries", async () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "iva-notifications-"));
  process.env.ASSISTANT_DATA_DIR = directory;
  try {
    const first = await createNotification({
      body: "Позвонить врачу",
      kind: "reminder",
      source: "test",
    });
    const second = await createNotification({ body: "Новый отчёт" });
    await setNotificationTelegramDelivery(first.id, "sent");

    const listed = await listNotifications();
    assert.deepEqual(
      listed.map((item) => item.id),
      [second.id, first.id],
    );
    assert.equal(listed[1]?.telegram?.status, "sent");
    assert.equal(await markNotificationRead(first.id), 1);
    assert.equal(await markNotificationRead(first.id), 0);
    assert.equal(await markNotificationRead(), 1);
    assert.ok((await listNotifications()).every((item) => item.readAt));

    assert.equal(await markNotificationRead(second.id, "librechat:dima"), 1);
    const storedSecond = (await listNotifications()).find(
      (item) => item.id === second.id,
    );
    assert.ok(storedSecond);
    assert.ok(notificationForPrincipal(storedSecond, "librechat:dima").readAt);
    assert.equal(
      notificationForPrincipal(storedSecond, "librechat:admin").readAt,
      undefined,
    );
    assert.equal(
      notificationForPrincipal(storedSecond, "librechat:dima").readBy,
      undefined,
    );

    const raw = JSON.parse(
      await readFile(join(directory, "notifications.json"), "utf8"),
    ) as { version: number };
    assert.equal(raw.version, 1);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});
