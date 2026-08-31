import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveTenantPath } from "./tenant-path.ts";
import type { TenantStore } from "./tenant-store.ts";

export type BlobMetadata = {
  readonly id: string;
  readonly originalName: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
};

export type SaveBlobOptions = {
  readonly originalName?: string;
  readonly mediaType?: string;
};

export interface BlobStore {
  save(data: Uint8Array, options?: SaveBlobOptions): BlobMetadata;
  read(id: string): { readonly data: Buffer; readonly metadata: BlobMetadata };
  delete(id: string): boolean;
}

export class BlobNotFoundError extends Error {
  readonly code = "EBLOB_NOT_FOUND";

  constructor() {
    super("Attachment is unavailable");
    this.name = "BlobNotFoundError";
  }
}

type AttachmentRow = {
  id: string;
  tenant_id: string;
  storage_key: string;
  original_name: string | null;
  media_type: string | null;
  size_bytes: number;
  sha256: string;
  created_at: string;
};

const ATTACHMENT_ID = /^att_[0-9a-f]{32}$/u;

function metadata(row: AttachmentRow): BlobMetadata {
  return Object.freeze({
    id: row.id,
    originalName: row.original_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  });
}

function optionalMetadata(
  value: string | undefined,
  limit: number,
): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > limit ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Invalid attachment metadata");
  }
  return normalized;
}

export class LocalBlobStore implements BlobStore {
  readonly #tenant: TenantStore;

  constructor(tenant: TenantStore) {
    this.#tenant = tenant;
  }

  #row(db: DatabaseSync, id: string): AttachmentRow | null {
    if (!ATTACHMENT_ID.test(id)) return null;
    const row = db
      .prepare(
        `SELECT id, tenant_id, storage_key, original_name, media_type,
                size_bytes, sha256, created_at
         FROM attachments WHERE id = ? AND tenant_id = ?`,
      )
      .get(id, this.#tenant.context.tenantId) as AttachmentRow | undefined;
    return row ?? null;
  }

  save(data: Uint8Array, options: SaveBlobOptions = {}): BlobMetadata {
    const id = `att_${randomUUID().replaceAll("-", "")}`;
    const storageKey = `attachments/${id}`;
    const path = resolveTenantPath(this.#tenant.context.vaultRoot, storageKey);
    const bytes = Buffer.from(data);
    const originalName = optionalMetadata(options.originalName, 512);
    const mediaType = optionalMetadata(options.mediaType, 255);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const createdAt = new Date().toISOString();
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      this.#tenant.withStateDatabase((db) => {
        db.prepare(
          `INSERT INTO attachments(
             id, tenant_id, storage_key, original_name, media_type,
             size_bytes, sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          this.#tenant.context.tenantId,
          storageKey,
          originalName,
          mediaType,
          bytes.byteLength,
          sha256,
          createdAt,
        );
      });
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    return Object.freeze({
      id,
      originalName,
      mediaType,
      sizeBytes: bytes.byteLength,
      sha256,
      createdAt,
    });
  }

  read(id: string): { readonly data: Buffer; readonly metadata: BlobMetadata } {
    const row = this.#tenant.withStateDatabase((db) => this.#row(db, id));
    if (row === null) throw new BlobNotFoundError();
    const path = resolveTenantPath(
      this.#tenant.context.vaultRoot,
      row.storage_key,
    );
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      throw new BlobNotFoundError();
    }
    if (
      data.byteLength !== row.size_bytes ||
      createHash("sha256").update(data).digest("hex") !== row.sha256
    ) {
      throw new BlobNotFoundError();
    }
    return Object.freeze({ data, metadata: metadata(row) });
  }

  delete(id: string): boolean {
    const row = this.#tenant.withStateDatabase((db) => this.#row(db, id));
    if (row === null) return false;
    const path = resolveTenantPath(
      this.#tenant.context.vaultRoot,
      row.storage_key,
    );
    this.#tenant.withStateDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "DELETE FROM attachments WHERE id = ? AND tenant_id = ?",
        ).run(id, this.#tenant.context.tenantId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    rmSync(path, { force: true });
    return true;
  }
}
