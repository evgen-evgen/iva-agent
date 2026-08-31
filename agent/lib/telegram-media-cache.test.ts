/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalBlobStore } from "./blob-store.ts";
import type { TenantContext } from "./tenant-context.ts";
import {
  getTelegramMediaCacheEntry,
  saveTelegramMediaCacheEntry,
  TELEGRAM_MEDIA_CACHE_LIMIT,
} from "./telegram-media-cache.ts";
import { TenantStore } from "./tenant-store.ts";

function context(root: string, marker: string): TenantContext {
  const tenantId = `t_${marker.repeat(32)}`;
  const dataRoot = join(root, tenantId);
  return {
    tenantId,
    role: "user",
    dataRoot,
    vaultRoot: join(dataRoot, "vault"),
  };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "iva-media-cache-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeA = new TenantStore(context(root, "a"));
  const storeB = new TenantStore(context(root, "b"));
  t.after(() => {
    storeA.close();
    storeB.close();
  });
  return {
    storeA,
    storeB,
    blobsA: new LocalBlobStore(storeA),
    blobsB: new LocalBlobStore(storeB),
  };
}

test("media cache reuses a tenant-owned opaque attachment and derived text", async (t) => {
  const { storeA, blobsA } = fixture(t);
  assert.equal(await getTelegramMediaCacheEntry(storeA, "photo-1"), null);
  const attachment = blobsA.save(Buffer.from("image"), {
    originalName: "photo.jpg",
    mediaType: "image/jpeg",
  });
  const entry = {
    attachmentId: attachment.id,
    vision: "a whiteboard",
    transcript: "",
    at: 10,
  };
  await saveTelegramMediaCacheEntry(storeA, "photo-1", entry);
  assert.deepEqual(await getTelegramMediaCacheEntry(storeA, "photo-1"), entry);
});

test("media cache cannot bind or resolve another tenant's attachment", async (t) => {
  const { storeA, storeB, blobsA } = fixture(t);
  const attachment = blobsA.save(Buffer.from("tenant-a-image"));
  await saveTelegramMediaCacheEntry(storeA, "same-telegram-file", {
    attachmentId: attachment.id,
    at: 1,
  });
  await saveTelegramMediaCacheEntry(storeB, "same-telegram-file", {
    attachmentId: attachment.id,
    at: 2,
  });

  assert.deepEqual(
    await getTelegramMediaCacheEntry(storeA, "same-telegram-file"),
    { attachmentId: attachment.id, at: 1 },
  );
  assert.equal(
    await getTelegramMediaCacheEntry(storeB, "same-telegram-file"),
    null,
  );
});

test("deleting a blob invalidates its media cache record", async (t) => {
  const { storeA, blobsA } = fixture(t);
  const attachment = blobsA.save(Buffer.from("temporary"));
  await saveTelegramMediaCacheEntry(storeA, "temporary-file", {
    attachmentId: attachment.id,
    at: 1,
  });
  assert.equal(blobsA.delete(attachment.id), true);
  assert.equal(
    await getTelegramMediaCacheEntry(storeA, "temporary-file"),
    null,
  );
});

test("media cache keeps only the 500 newest records per tenant", async (t) => {
  const { storeA, blobsA } = fixture(t);
  const attachment = blobsA.save(Buffer.from("shared-test-object"));
  storeA.withStateDatabase((db) => {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare(
      `INSERT INTO telegram_media_cache(
         file_unique_id, tenant_id, attachment_id, at
       ) VALUES (?, ?, ?, ?)`,
    );
    for (let index = 0; index <= TELEGRAM_MEDIA_CACHE_LIMIT; index += 1) {
      insert.run(`old-${index}`, storeA.context.tenantId, attachment.id, index);
    }
    db.exec("COMMIT");
  });

  await saveTelegramMediaCacheEntry(storeA, "newest", {
    attachmentId: attachment.id,
    at: 10_000,
  });
  const count = storeA.withStateDatabase(
    (db) =>
      (
        db
          .prepare(
            "SELECT count(*) AS count FROM telegram_media_cache WHERE tenant_id = ?",
          )
          .get(storeA.context.tenantId) as { count: number }
      ).count,
  );
  assert.equal(count, TELEGRAM_MEDIA_CACHE_LIMIT);
  assert.notEqual(await getTelegramMediaCacheEntry(storeA, "newest"), null);
  assert.equal(await getTelegramMediaCacheEntry(storeA, "old-0"), null);
  assert.equal(await getTelegramMediaCacheEntry(storeA, "old-1"), null);
});
