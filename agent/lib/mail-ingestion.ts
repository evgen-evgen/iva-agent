import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withImportClient } from "./plugin-import-client.ts";
import { readPluginEnv } from "./plugin-config.ts";
import {
  storeSource,
  getCursor,
  setCursor,
  listPendingSources,
  claimSources,
  releaseSources,
  finishSource,
  readSource,
  listCompletedSourceReports,
  retrySourceDelivery,
} from "./ingestion-store.ts";
import {
  createNotification,
  getNotification,
  getNotifications,
  notificationIdForKey,
  type IvaNotification,
} from "./notification-store.ts";

const mailSchema = z.object({
  key: z.string(),
  revision: z.string(),
  account: z.string(),
  mailbox: z.string(),
  uidvalidity: z.string(),
  uid: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type ImportedMail = z.infer<typeof mailSchema>;
export type MailCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
export const mailAccount = () =>
  createHash("sha256")
    .update(
      JSON.stringify([
        readPluginEnv("iva-mail").MAIL_IMAP_HOST,
        readPluginEnv("iva-mail").MAIL_USERNAME,
      ]),
    )
    .digest("hex");
export async function withReadOnlyMail<T>(
  run: (call: MailCall) => Promise<T>,
): Promise<T> {
  return withImportClient("iva-mail", "mail", (client) =>
    run(async (name, args) => {
      if (
        ![
          "mail_poll_messages",
          "mail_read_message",
          "mail_connection_status",
        ].includes(name)
      )
        throw new Error("Background mail supports read-only tools only");
      const invoke = () =>
        client.callTool(
          {
            name,
            arguments:
              name === "mail_read_message"
                ? { ...args, mark_seen: false }
                : args,
          },
          undefined,
          { timeout: 60_000 },
        );
      let result = await invoke();
      if (result.isError) {
        const diagnostic = JSON.stringify(result.content);
        // Read-only operations may be safely retried after transient network loss.
        // Authentication/configuration failures are never retried blindly.
        if (
          /timed? out|timeout|connection.*(?:closed|reset)/iu.test(diagnostic)
        ) {
          await delay(1_000);
          result = await invoke();
        }
        if (result.isError)
          throw new Error(
            "Mail reading failed; check private server logs and connection settings",
          );
      }
      const texts = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .parse(result.content)
        .filter((x) => x.type === "text")
        .map((x) => x.text ?? "")
        .join("\n");
      return JSON.parse(texts) as unknown;
    }),
  );
}
const pollSchema = z.object({
  uidvalidity: z.string().regex(/^\d+$/u),
  baseline: z.boolean(),
  uids: z.array(z.string().regex(/^\d+$/u)),
  last_uid: z.number().int().nonnegative(),
});
export async function syncNewMail(
  call: MailCall,
  account: string,
  mailbox = "INBOX",
) {
  const cursor = await getCursor("mail", account, mailbox);
  const poll = pollSchema.parse(
    await call("mail_poll_messages", {
      mailbox,
      limit: 25,
      ...(cursor
        ? { after_uid: cursor.last_uid, uidvalidity: cursor.uidvalidity }
        : {}),
    }),
  );
  if (poll.baseline) {
    await setCursor("mail", account, mailbox, {
      uidvalidity: poll.uidvalidity,
      last_uid: poll.last_uid,
    });
    return { baseline: true, imported: 0 };
  }
  let imported = 0;
  // Advance only after archiving every UID. A failed message is retried, never skipped.
  for (const uid of poll.uids) {
    const message = z.record(z.string(), z.unknown()).parse(
      await call("mail_read_message", {
        mailbox,
        uid,
        uidvalidity: poll.uidvalidity,
        mark_seen: false,
        max_body_chars: 100_000,
      }),
    );
    const externalId = `${mailbox}:${poll.uidvalidity}:${uid}`;
    const key = createHash("sha256")
      .update(JSON.stringify(["mail", account, externalId]))
      .digest("hex");
    const revision = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex");
    const raw = {
      key,
      revision,
      account,
      mailbox,
      uidvalidity: poll.uidvalidity,
      uid,
      message,
    };
    await storeSource({
      provider: "mail",
      account,
      externalId,
      key,
      revision,
      metadata: {
        subject: message.subject,
        from: message.from,
        date: message.date,
        message_id: message.message_id,
      },
      raw,
    });
    await setCursor("mail", account, mailbox, {
      uidvalidity: poll.uidvalidity,
      last_uid: Number(uid),
    });
    imported++;
  }
  return { baseline: false, imported };
}
const mailProcessingStore = {
  listPendingSources,
  claimSources,
  releaseSources,
  readSource,
  finishSource,
  listCompletedSourceReports,
  retrySourceDelivery,
};

export async function processMail(
  account: string,
  summarize: (source: ImportedMail) => Promise<string>,
  deliver?: (notification: IvaNotification) => Promise<void>,
  store = mailProcessingStore,
) {
  // Recover reports marked done by older versions despite a failed Telegram send.
  if (deliver) {
    const completed = await store.listCompletedSourceReports("mail", account);
    const failedIds = new Set(
      (await getNotifications(completed.map((item) => item.reportId)))
        .filter((notification) => notification.telegram?.status === "failed")
        .map((notification) => notification.id),
    );
    for (const item of completed) {
      if (failedIds.has(item.reportId))
        await store.retrySourceDelivery(item.key, item.revision);
    }
  }
  const queued = (await store.listPendingSources("mail", account)).map((x) =>
    mailSchema.parse(x),
  );
  const selected = await store.claimSources(
    queued.slice(0, 5).map((x) => ({ key: x.key, revision: x.revision })),
  );
  let processed = 0;
  let errors = 0;
  try {
    for (const item of selected) {
      try {
        const source = mailSchema.parse(await store.readSource(item.key));
        const idempotencyKey = `mail:${source.key}:${source.revision}`;
        // Saving the report precedes delivery. Reuse it after delivery or finish failures.
        let notification = await getNotification(
          notificationIdForKey(idempotencyKey),
        );
        if (!notification) {
          const report = (await summarize(source)).trim();
          if (!report) throw new Error("Mail summary was empty");
          const subject =
            typeof source.message.subject === "string"
              ? source.message.subject
              : "Без темы";
          notification = await createNotification({
            kind: "report",
            title: `Письмо: ${subject}`.slice(0, 160),
            body: report,
            source: `mail:${source.key}`,
            idempotencyKey,
          });
        }
        if (deliver && notification.telegram?.status !== "sent") {
          await deliver(notification);
          if (
            (await getNotification(notification.id))?.telegram?.status ===
            "failed"
          )
            throw new Error("Mail report delivery failed");
        }
        await store.finishSource(
          source.key,
          source.revision,
          {
            report: notification.body,
            reportId: notification.id,
            processedAt: new Date().toISOString(),
          },
          notification.id,
        );
        processed++;
      } catch {
        // A malformed or temporarily unavailable message cannot block other mail.
        errors++;
      }
    }
  } finally {
    await store.releaseSources(selected);
  }
  return { processed, pending: queued.length - processed, errors };
}
