import type { TenantStore } from "./tenant-store.ts";

export const TELEGRAM_MEDIA_CACHE_LIMIT = 500;

export type TelegramMediaCacheEntry = {
  attachmentId: string;
  vision?: string;
  transcript?: string;
  at: number;
};

type CacheRow = {
  attachment_id: string;
  vision: string | null;
  transcript: string | null;
  at: number;
};

const ATTACHMENT_ID = /^att_[0-9a-f]{32}$/u;

function validFileUniqueId(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.includes("\0");
}

export function getTelegramMediaCacheEntry(
  store: TenantStore,
  fileUniqueId: string,
): Promise<TelegramMediaCacheEntry | null> {
  if (!validFileUniqueId(fileUniqueId)) return Promise.resolve(null);
  const row = store.withStateDatabase((db) =>
    db
      .prepare(
        `SELECT cache.attachment_id, cache.vision, cache.transcript, cache.at
         FROM telegram_media_cache AS cache
         JOIN attachments AS attachment
           ON attachment.id = cache.attachment_id
          AND attachment.tenant_id = cache.tenant_id
         WHERE cache.file_unique_id = ? AND cache.tenant_id = ?`,
      )
      .get(fileUniqueId, store.context.tenantId),
  ) as CacheRow | undefined;
  if (row === undefined) return Promise.resolve(null);
  return Promise.resolve({
    attachmentId: row.attachment_id,
    ...(row.vision === null ? {} : { vision: row.vision }),
    ...(row.transcript === null ? {} : { transcript: row.transcript }),
    at: row.at,
  });
}

export function saveTelegramMediaCacheEntry(
  store: TenantStore,
  fileUniqueId: string,
  entry: TelegramMediaCacheEntry,
): Promise<void> {
  if (
    !validFileUniqueId(fileUniqueId) ||
    !ATTACHMENT_ID.test(entry.attachmentId) ||
    !Number.isSafeInteger(entry.at) ||
    (entry.vision !== undefined && typeof entry.vision !== "string") ||
    (entry.transcript !== undefined && typeof entry.transcript !== "string")
  ) {
    return Promise.resolve();
  }
  store.withStateDatabase((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const owned = db
        .prepare("SELECT 1 FROM attachments WHERE id = ? AND tenant_id = ?")
        .get(entry.attachmentId, store.context.tenantId);
      if (owned === undefined) {
        db.exec("ROLLBACK");
        return;
      }
      db.prepare(
        `INSERT INTO telegram_media_cache(
           file_unique_id, tenant_id, attachment_id, vision, transcript, at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_unique_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           attachment_id = excluded.attachment_id,
           vision = excluded.vision,
           transcript = excluded.transcript,
           at = excluded.at`,
      ).run(
        fileUniqueId,
        store.context.tenantId,
        entry.attachmentId,
        entry.vision ?? null,
        entry.transcript ?? null,
        entry.at,
      );
      db.prepare(
        `DELETE FROM telegram_media_cache
         WHERE file_unique_id IN (
           SELECT file_unique_id FROM telegram_media_cache
           WHERE tenant_id = ?
           ORDER BY at DESC, file_unique_id DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(store.context.tenantId, TELEGRAM_MEDIA_CACHE_LIMIT);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return Promise.resolve();
}
