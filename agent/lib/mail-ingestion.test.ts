/* eslint-disable @typescript-eslint/require-await -- Async doubles follow the storage and delivery contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processMail } from "./mail-ingestion.ts";
import {
  createNotification,
  getNotification,
  listNotifications,
  setNotificationTelegramDelivery,
} from "./notification-store.ts";

void test("mail retries saved reports after failed delivery, including formerly completed jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iva-mail-retry-"));
  const previous = {
    data: process.env.ASSISTANT_DATA_DIR,
    secret: process.env.LIBRECHAT_NOTIFICATION_SECRET,
  };
  process.env.ASSISTANT_DATA_DIR = directory;
  delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
  try {
    const source = {
      key: "mail-key",
      revision: "rev",
      account: "account",
      mailbox: "INBOX",
      uidvalidity: "77",
      uid: "101",
      message: { subject: "Test" },
    };
    let done = false;
    let reportId: string | undefined;
    let analysis: unknown;
    let failFinish = false;
    const store: NonNullable<Parameters<typeof processMail>[3]> = {
      listPendingSources: async () => (done ? [] : [source]),
      claimSources: async (items) =>
        items.map((item) => ({ ...item, lease: "test" })),
      releaseSources: async () => {},
      readSource: async () => source,
      finishSource: async (_key, _revision, saved, id) => {
        if (failFinish) throw new Error("Database unavailable");
        done = true;
        reportId = id;
        analysis = saved;
      },
      listCompletedSourceReports: async () =>
        done && reportId
          ? [{ key: source.key, revision: source.revision, reportId }]
          : [],
      retrySourceDelivery: async () => {
        done = false;
      },
    };
    let modelCalls = 0;
    const summarize = async () => {
      modelCalls++;
      return "Saved report";
    };
    // Reproduce a callback that records failure but resolves normally.
    const failed = await processMail(
      "account",
      summarize,
      async (notification) => {
        await setNotificationTelegramDelivery(
          notification.id,
          "failed",
          "Unavailable",
        );
      },
      store,
    );
    assert.deepEqual(failed, { processed: 0, pending: 1, errors: 1 });
    assert.equal(done, false);
    const [original] = await listNotifications();
    assert.equal(original.body, "Saved report");
    assert.equal(original.telegram?.status, "failed");

    const thrown = await processMail(
      "account",
      summarize,
      async (notification) => {
        assert.equal(notification.id, original.id);
        throw new Error("Network unavailable");
      },
      store,
    );
    assert.equal(thrown.errors, 1);
    assert.equal(modelCalls, 1);

    let sends = 0;
    const deliver = async (notification: typeof original) => {
      sends++;
      assert.equal(notification.id, original.id);
      assert.equal(notification.body, original.body);
      await setNotificationTelegramDelivery(notification.id, "sent");
    };
    // A successful send followed by a database failure must not resend or rerun the model.
    failFinish = true;
    assert.equal(
      (await processMail("account", summarize, deliver, store)).errors,
      1,
    );
    failFinish = false;
    assert.deepEqual(await processMail("account", summarize, deliver, store), {
      processed: 1,
      pending: 0,
      errors: 0,
    });
    assert.equal(sends, 1);
    assert.equal(modelCalls, 1);
    assert.equal((analysis as { report: string }).report, original.body);
    assert.equal(
      (await getNotification(original.id))?.telegram?.status,
      "sent",
    );

    // Old versions could already have marked this failed delivery as done.
    await setNotificationTelegramDelivery(original.id, "failed");
    assert.deepEqual(await processMail("account", summarize, deliver, store), {
      processed: 1,
      pending: 0,
      errors: 0,
    });
    assert.equal(sends, 2);
    assert.equal(modelCalls, 1);
    assert.equal((await listNotifications()).length, 1);
    assert.equal(
      (await processMail("account", summarize, deliver, store)).processed,
      0,
    );
    assert.equal(sends, 2);

    // Missing configuration is an intentional skip rather than a retryable failure.
    done = false;
    const skipped = await createNotification({
      body: "Skipped report",
      idempotencyKey: "mail:mail-key:rev2",
    });
    source.revision = "rev2";
    assert.equal(
      (
        await processMail(
          "account",
          summarize,
          async (notification) => {
            await setNotificationTelegramDelivery(notification.id, "skipped");
          },
          store,
        )
      ).processed,
      1,
    );
    assert.equal(
      (await getNotification(skipped.id))?.telegram?.status,
      "skipped",
    );
    assert.equal(modelCalls, 1);
  } finally {
    if (previous.data === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous.data;
    if (previous.secret === undefined)
      delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
    else process.env.LIBRECHAT_NOTIFICATION_SECRET = previous.secret;
    await rm(directory, { recursive: true, force: true });
  }
});
