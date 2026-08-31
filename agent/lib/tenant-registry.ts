import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeTenantIdentity,
  type TenantIdentity,
  type TenantLookup,
  type TenantRecord,
  type TenantStatus,
} from "./tenant-context.ts";

const SCHEMA_VERSION = 1;

type TenantRow = {
  id: string;
  role: "owner" | "user";
  status: TenantStatus;
  telegram_destination: string | null;
};

export type CreateTenantOptions = {
  readonly role?: "owner" | "user";
  readonly status?: TenantStatus;
  readonly telegramDestination?: string | null;
};

export type TenantIdentityRecord = TenantRecord & {
  readonly identity: TenantIdentity;
};

function opaqueTenantId(): string {
  return `t_${randomUUID().replaceAll("-", "")}`;
}

function tenantRecord(row: TenantRow): TenantRecord {
  return {
    tenantId: row.id,
    role: row.role,
    status: row.status,
    telegramDestination: row.telegram_destination,
  };
}

function assertSchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version.user_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported tenant registry schema version ${version.user_version}`,
    );
  }
  const integrity = db.prepare("PRAGMA quick_check").get() as {
    quick_check: string;
  };
  if (integrity.quick_check !== "ok") {
    throw new Error(
      `Tenant registry integrity check failed: ${integrity.quick_check}`,
    );
  }
  const required = new Set(["tenants", "tenant_identities"]);
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const row of rows) required.delete(row.name);
  if (required.size > 0) {
    throw new Error(
      `Tenant registry schema is incomplete: ${[...required].join(", ")}`,
    );
  }
}

function migrate(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version.user_version > SCHEMA_VERSION) {
    throw new Error(
      `Tenant registry schema ${version.user_version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  if (version.user_version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('owner', 'user')),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        telegram_destination TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE tenant_identities (
        authenticator TEXT NOT NULL,
        issuer TEXT NOT NULL,
        external_principal TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (authenticator, issuer, external_principal),
        UNIQUE (tenant_id, authenticator, issuer)
      ) STRICT;
      CREATE INDEX tenant_identities_tenant_id
        ON tenant_identities(tenant_id);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  assertSchema(db);
}

export class TenantRegistry implements TenantLookup {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      const journal = this.#db.prepare("PRAGMA journal_mode = WAL").get() as {
        journal_mode: string;
      };
      if (journal.journal_mode.toLowerCase() !== "wal") {
        throw new Error("Tenant registry could not enable WAL mode");
      }
      this.#db.exec("PRAGMA synchronous = FULL;");
      migrate(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  findByIdentity(identity: TenantIdentity): TenantRecord | null {
    const normalized = normalizeTenantIdentity(identity);
    const row = this.#db
      .prepare(
        `SELECT t.id, t.role, t.status, t.telegram_destination
         FROM tenant_identities AS i
         JOIN tenants AS t ON t.id = i.tenant_id
         WHERE i.authenticator = ? AND i.issuer = ? AND i.external_principal = ?`,
      )
      .get(
        normalized.authenticator,
        normalized.issuer,
        normalized.externalPrincipal,
      ) as TenantRow | undefined;
    return row === undefined ? null : tenantRecord(row);
  }

  get(tenantId: string): TenantRecord | null {
    const row = this.#db
      .prepare(
        "SELECT id, role, status, telegram_destination FROM tenants WHERE id = ?",
      )
      .get(tenantId) as TenantRow | undefined;
    return row === undefined ? null : tenantRecord(row);
  }

  create(
    identity: TenantIdentity,
    options: CreateTenantOptions = {},
  ): TenantRecord {
    const normalized = normalizeTenantIdentity(identity);
    const existing = this.findByIdentity(normalized);
    if (existing !== null) return existing;

    const tenantId = opaqueTenantId();
    const role = options.role ?? "user";
    const status = options.status ?? "active";
    const destination = options.telegramDestination ?? null;
    const createdAt = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const afterLock = this.findByIdentity(normalized);
      if (afterLock !== null) {
        this.#db.exec("COMMIT");
        return afterLock;
      }
      this.#db
        .prepare(
          `INSERT INTO tenants(id, role, status, telegram_destination, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tenantId, role, status, destination, createdAt);
      this.#db
        .prepare(
          `INSERT INTO tenant_identities(
             authenticator, issuer, external_principal, tenant_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.authenticator,
          normalized.issuer,
          normalized.externalPrincipal,
          tenantId,
          createdAt,
        );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.get(tenantId) as TenantRecord;
  }

  update(
    tenantId: string,
    patch: {
      readonly role?: "owner" | "user";
      readonly status?: TenantStatus;
      readonly telegramDestination?: string | null;
    },
  ): TenantRecord {
    const current = this.get(tenantId);
    if (current === null) throw new Error("Unknown tenant");
    this.#db
      .prepare(
        `UPDATE tenants SET role = ?, status = ?, telegram_destination = ?
         WHERE id = ?`,
      )
      .run(
        patch.role ?? current.role,
        patch.status ?? current.status,
        patch.telegramDestination === undefined
          ? current.telegramDestination
          : patch.telegramDestination,
        tenantId,
      );
    return this.get(tenantId) as TenantRecord;
  }

  listActive(): TenantRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, role, status, telegram_destination
         FROM tenants WHERE status = 'active' ORDER BY created_at, id`,
      )
      .all() as TenantRow[];
    return rows.map(tenantRecord);
  }

  listByAuthenticator(
    authenticator: string,
    issuer: string,
  ): TenantIdentityRecord[] {
    const normalized = normalizeTenantIdentity({
      authenticator,
      issuer,
      externalPrincipal: "placeholder",
    });
    const rows = this.#db
      .prepare(
        `SELECT t.id, t.role, t.status, t.telegram_destination,
                i.authenticator, i.issuer, i.external_principal
         FROM tenant_identities AS i
         JOIN tenants AS t ON t.id = i.tenant_id
         WHERE i.authenticator = ? AND i.issuer = ?
         ORDER BY t.created_at, t.id`,
      )
      .all(normalized.authenticator, normalized.issuer) as Array<
      TenantRow & {
        authenticator: string;
        issuer: string;
        external_principal: string;
      }
    >;
    return rows.map((row) => ({
      ...tenantRecord(row),
      identity: {
        authenticator: row.authenticator,
        issuer: row.issuer,
        externalPrincipal: row.external_principal,
      },
    }));
  }
}
