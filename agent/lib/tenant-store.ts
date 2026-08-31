import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TenantContext } from "./tenant-context.ts";

const STATE_SCHEMA_VERSION = 4;
const TENANT_DIRECTORIES = [
  "runtime",
  "vault",
  "vault/daily",
  "vault/cards",
  "vault/summaries",
  "vault/attachments",
] as const;

function initializeState(db: DatabaseSync): void {
  let version = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version.user_version > STATE_SCHEMA_VERSION) {
    throw new Error(
      `Tenant state schema ${version.user_version} is newer than supported ${STATE_SCHEMA_VERSION}`,
    );
  }
  if (version.user_version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE tenant_state_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    version = { user_version: 1 };
  }
  if (version.user_version === 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        original_name TEXT,
        media_type TEXT,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;
    `);
    version = { user_version: 2 };
  }
  if (version.user_version === 2) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('low', 'med', 'high')),
        due TEXT,
        done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 3;
      COMMIT;
    `);
    version = { user_version: 3 };
  }
  if (version.user_version === 3) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE telegram_media_cache (
        file_unique_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        vision TEXT,
        transcript TEXT,
        at INTEGER NOT NULL,
        FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX telegram_media_cache_recent
        ON telegram_media_cache(at DESC);
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
  const integrity = db.prepare("PRAGMA quick_check").get() as {
    quick_check: string;
  };
  if (integrity.quick_check !== "ok") {
    throw new Error(
      `Tenant state integrity check failed: ${integrity.quick_check}`,
    );
  }
}

export class TenantStore {
  readonly context: TenantContext;
  readonly statePath: string;
  readonly #db: DatabaseSync;

  constructor(context: TenantContext) {
    this.context = context;
    const requestedRoot = resolve(context.dataRoot);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    chmodSync(requestedRoot, 0o700);
    const physicalRoot = realpathSync(requestedRoot);
    if (physicalRoot !== requestedRoot) {
      throw new Error("Tenant data root must not be a symbolic link");
    }
    for (const relative of TENANT_DIRECTORIES) {
      const directory = join(requestedRoot, relative);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.statePath = join(requestedRoot, "state.sqlite");
    this.#db = new DatabaseSync(this.statePath);
    try {
      chmodSync(this.statePath, 0o600);
      this.#db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;",
      );
      const journal = this.#db.prepare("PRAGMA journal_mode = WAL").get() as {
        journal_mode: string;
      };
      if (journal.journal_mode.toLowerCase() !== "wal") {
        throw new Error("Tenant state could not enable WAL mode");
      }
      initializeState(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  withStateDatabase<T>(operation: (db: DatabaseSync) => T): T {
    return operation(this.#db);
  }
}
