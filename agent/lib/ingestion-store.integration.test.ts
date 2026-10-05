/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement the production callback contract. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  storeSource,
  readSource,
  claimSources,
  releaseSources,
  finishSource,
  readSourceAnalysis,
  getCursor,
  closeIngestion,
} from "./ingestion-store.ts";
import { syncNewMail, processMail } from "./mail-ingestion.ts";
import { listNotifications } from "./notification-store.ts";

void test(
  "real PostgreSQL/S3: new mail only, durable cursor, exclusive claims and report retries",
  { skip: process.env.IVA_RUN_INGESTION_TESTS !== "1" },
  async () => {
    const account = `test-${randomUUID()}`;
    const sql = postgres(process.env.IVA_METADATA_DATABASE_URL!, {
      onnotice: () => {},
    });
    const s3 = new S3Client({
      endpoint: process.env.IVA_ARCHIVE_ENDPOINT,
      region: "garage",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.IVA_ARCHIVE_ACCESS_KEY!,
        secretAccessKey: process.env.IVA_ARCHIVE_SECRET_KEY!,
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "iva-mail-ingestion-"));
    const original = {
      data: process.env.ASSISTANT_DATA_DIR,
      secret: process.env.LIBRECHAT_NOTIFICATION_SECRET,
    };
    process.env.ASSISTANT_DATA_DIR = directory;
    delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
    try {
      const baseline = await syncNewMail(async (name, args) => {
        assert.equal(name, "mail_poll_messages");
        assert.equal(args.after_uid, undefined);
        return { baseline: true, uidvalidity: "77", last_uid: 100, uids: [] };
      }, account);
      assert.equal(baseline.imported, 0);
      let fail = true;
      const call = async (name: string, args: Record<string, unknown>) => {
        if (name === "mail_poll_messages") {
          assert.equal(args.after_uid, 100);
          return {
            baseline: false,
            uidvalidity: "77",
            last_uid: 101,
            uids: ["101"],
          };
        }
        assert.equal(args.mark_seen, false);
        assert.equal(args.uidvalidity, "77");
        if (fail) throw new Error("Transient IMAP failure");
        return {
          from: "fixture@example.com",
          subject: "New incoming",
          body: "Please review",
          attachments: [],
        };
      };
      await assert.rejects(syncNewMail(call, account), /Transient/u);
      assert.equal((await getCursor("mail", account, "INBOX"))?.last_uid, 100);
      fail = false;
      assert.equal((await syncNewMail(call, account)).imported, 1);
      const [source] =
        await sql`SELECT * FROM iva_ingestion.sources WHERE account=${account}`;
      const key = String(source.source_key),
        revision = String(source.revision);
      assert.equal((await getCursor("mail", account, "INBOX"))?.last_uid, 101);
      const raw = (await readSource(key)) as { message: { subject: string } };
      assert.equal(raw.message.subject, "New incoming");
      const claims = await Promise.all([
        claimSources([{ key, revision }]),
        claimSources([{ key, revision }]),
      ]);
      assert.equal(claims.flat().length, 1);
      await releaseSources([{ key, revision, lease: "wrong" }]);
      assert.equal((await claimSources([{ key, revision }])).length, 0);
      await releaseSources(claims.flat());
      await sql`UPDATE iva_ingestion.jobs SET next_attempt_at=now() WHERE source_key=${key}`;
      assert.equal(
        (await processMail(account, async () => "Fixture analysis")).processed,
        1,
      );
      assert.equal(
        (
          await processMail(account, async () => {
            throw new Error("Must not rerun");
          })
        ).processed,
        0,
      );
      assert.equal((await listNotifications()).length, 1);
      await finishSource(key, revision, { report: "Overwrite attempt" });
      assert.equal(
        ((await readSourceAnalysis(key)) as { report: string }).report,
        "Fixture analysis",
      );
      await storeSource({
        provider: "mail",
        account,
        externalId: String(source.external_id),
        key,
        revision,
        metadata: {},
        raw,
      });
      assert.equal((await claimSources([{ key, revision }])).length, 0);
      for (const uid of ["102", "103"]) {
        const nextKey = `${account}-${uid}`;
        await storeSource({
          provider: "mail",
          account,
          externalId: `INBOX:77:${uid}`,
          key: nextKey,
          revision: "fixture-revision",
          metadata: {},
          raw: {
            key: nextKey,
            revision: "fixture-revision",
            account,
            mailbox: "INBOX",
            uidvalidity: "77",
            uid,
            message: {
              subject: uid === "102" ? "Unavailable" : "Good second message",
            },
          },
        });
      }
      const mixed = await processMail(account, async (source) => {
        if (source.uid === "102") throw new Error("One source failed");
        return "Second fixture analysis";
      });
      assert.equal(mixed.errors, 1);
      assert.equal(mixed.processed, 1);
      assert.equal(mixed.pending, 1);
      assert.equal((await listNotifications()).length, 2);
    } finally {
      const rows =
        await sql`SELECT s.raw_key,j.analysis_key FROM iva_ingestion.sources s JOIN iva_ingestion.jobs j ON j.source_key=s.source_key WHERE s.account=${account}`;
      const rawKeys = rows.flatMap((x) => [
        String(x.raw_key),
        ...(x.analysis_key ? [String(x.analysis_key)] : []),
      ]);
      await sql`DELETE FROM iva_ingestion.jobs WHERE source_key IN (SELECT source_key FROM iva_ingestion.sources WHERE account=${account})`;
      await sql`DELETE FROM iva_ingestion.sources WHERE account=${account}`;
      await sql`DELETE FROM iva_ingestion.cursors WHERE account=${account}`;
      for (const key of rawKeys)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.IVA_ARCHIVE_BUCKET,
            Key: key,
          }),
        );
      s3.destroy();
      await sql.end();
      await closeIngestion();
      if (original.data === undefined) delete process.env.ASSISTANT_DATA_DIR;
      else process.env.ASSISTANT_DATA_DIR = original.data;
      if (original.secret === undefined)
        delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
      else process.env.LIBRECHAT_NOTIFICATION_SECRET = original.secret;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
