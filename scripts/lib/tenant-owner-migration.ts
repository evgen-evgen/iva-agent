import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TenantRegistry } from "../../agent/lib/tenant-registry.ts";
import { tenantContextForRecord } from "../../agent/lib/tenant-context.ts";
import { TenantStore } from "../../agent/lib/tenant-store.ts";
import { writeFileAtomicSync } from "../../agent/lib/fs-atomic.ts";

export type MigrationFile = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type OwnerMigrationPlan = {
  readonly tenantId: string;
  readonly sourceVault: string;
  readonly targetVault: string;
  readonly files: readonly MigrationFile[];
  readonly totalBytes: number;
  readonly structuredState: readonly string[];
};

export type OwnerMigrationResult = OwnerMigrationPlan & {
  readonly migrationId: string;
  readonly backupVault: string;
  readonly rollbackMetadata: string;
};

type PlanOptions = {
  readonly registry: Pick<TenantRegistry, "listActive">;
  readonly dataDir: string;
  readonly sourceVault: string;
};

type ApplyOptions = PlanOptions & {
  readonly failAt?: "after-stage" | "after-publish" | "after-source-archive";
};

const STRUCTURED_STATE = [
  "settings.json",
  "tasks.json",
  "rollup-abandoned.jsonl",
] as const;

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventory(root: string): MigrationFile[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`Legacy vault is not a directory: ${root}`);
  }
  const files: MigrationFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Legacy vault contains a symbolic link: ${relative(root, absolute)}`,
        );
      }
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const stat = lstatSync(absolute);
        files.push({
          path: relative(root, absolute).split("\\").join("/"),
          bytes: stat.size,
          sha256: hash(absolute),
        });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function manifestsEqual(
  left: readonly MigrationFile[],
  right: readonly MigrationFile[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyTree(root: string): boolean {
  if (!existsSync(root)) return true;
  if (!lstatSync(root).isDirectory()) return false;
  return readdirSync(root, { withFileTypes: true }).every((entry) =>
    entry.isDirectory() ? emptyTree(join(root, entry.name)) : false,
  );
}

function structuredState(dataDir: string): string[] {
  const names = STRUCTURED_STATE.filter((name) =>
    existsSync(join(dataDir, name)),
  );
  for (const name of readdirSync(dataDir)) {
    if (/^rollup-session-(daily|weekly|monthly|yearly)\.json$/u.test(name)) {
      names.push(name as (typeof STRUCTURED_STATE)[number]);
    }
  }
  return [...new Set<string>(names)].sort();
}

export function planOwnerMigration({
  registry,
  dataDir,
  sourceVault,
}: PlanOptions): OwnerMigrationPlan {
  const owners = registry
    .listActive()
    .filter((record) => record.role === "owner");
  if (owners.length !== 1) {
    throw new Error(
      `Tenant migration requires exactly one active owner; found ${owners.length}`,
    );
  }
  const owner = owners[0];
  const context = tenantContextForRecord(owner, join(dataDir, "tenants"));
  const files = inventory(sourceVault);
  return {
    tenantId: owner.tenantId,
    sourceVault,
    targetVault: context.vaultRoot,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    structuredState: structuredState(dataDir),
  };
}

function importTasks(file: string, store: TenantStore): void {
  if (!existsSync(file)) return;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error("Legacy tasks.json is not an array");
  store.withStateDatabase((db) => {
    const count = db.prepare("SELECT count(*) AS n FROM tasks").get() as {
      n: number;
    };
    if (count.n !== 0) throw new Error("Target tenant already has tasks");
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(
        `INSERT INTO tasks(id, text, priority, due, done, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const value of parsed) {
        if (typeof value !== "object" || value === null) {
          throw new Error("Legacy tasks.json contains an invalid task");
        }
        const task = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(task.id) ||
          Number(task.id) <= 0 ||
          typeof task.text !== "string" ||
          !["low", "med", "high"].includes(String(task.priority)) ||
          !(task.due === null || typeof task.due === "string") ||
          typeof task.done !== "boolean" ||
          typeof task.createdAt !== "string"
        ) {
          throw new Error("Legacy tasks.json contains an invalid task");
        }
        insert.run(
          task.id as number,
          task.text,
          task.priority as string,
          task.due,
          task.done ? 1 : 0,
          task.createdAt,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function applyOwnerMigration(
  options: ApplyOptions,
): OwnerMigrationResult {
  const plan = planOwnerMigration(options);
  if (!emptyTree(plan.targetVault)) {
    throw new Error("Owner tenant vault is not empty; refusing migration");
  }
  const migrationId = `${Date.now()}-${randomUUID()}`;
  const tenantRoot = dirname(plan.targetVault);
  const stage = join(tenantRoot, `.owner-migration-stage-${migrationId}`);
  const backupRoot = join(
    options.dataDir,
    "tenant-migration-backups",
    migrationId,
  );
  const backupVault = join(backupRoot, "vault");
  const archivedSource = join(
    dirname(plan.sourceVault),
    `${basename(plan.sourceVault)}.tenant-migrated-${migrationId}`,
  );
  const rollbackMetadata = join(backupRoot, "rollback.json");
  const ownerRecord = options.registry
    .listActive()
    .find((record) => record.tenantId === plan.tenantId);
  if (ownerRecord === undefined)
    throw new Error("Owner tenant became inactive");
  const context = tenantContextForRecord(
    ownerRecord,
    join(options.dataDir, "tenants"),
  );
  const statePath = join(context.dataRoot, "state.sqlite");
  const stateExisted = existsSync(statePath);
  const copiedState: string[] = [];
  let importedTasks = false;
  mkdirSync(tenantRoot, { recursive: true, mode: 0o700 });
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

  let published = false;
  let archived = false;
  try {
    cpSync(plan.sourceVault, stage, { recursive: true, errorOnExist: true });
    if (!manifestsEqual(plan.files, inventory(stage))) {
      throw new Error("Staged vault verification failed");
    }
    cpSync(plan.sourceVault, backupVault, {
      recursive: true,
      errorOnExist: true,
    });
    if (!manifestsEqual(plan.files, inventory(backupVault))) {
      throw new Error("Backup vault verification failed");
    }
    if (options.failAt === "after-stage")
      throw new Error("Injected migration failure");

    if (existsSync(plan.targetVault))
      rmSync(plan.targetVault, { recursive: true });
    renameSync(stage, plan.targetVault);
    published = true;
    if (options.failAt === "after-publish")
      throw new Error("Injected migration failure");

    const store = new TenantStore(context);
    try {
      for (const name of plan.structuredState) {
        if (name === "tasks.json") continue;
        cpSync(join(options.dataDir, name), join(context.dataRoot, name), {
          errorOnExist: true,
        });
        copiedState.push(name);
      }
      importTasks(join(options.dataDir, "tasks.json"), store);
      importedTasks = plan.structuredState.includes("tasks.json");
    } finally {
      store.close();
    }

    renameSync(plan.sourceVault, archivedSource);
    archived = true;
    if (options.failAt === "after-source-archive") {
      throw new Error("Injected migration failure");
    }
    writeFileAtomicSync(
      rollbackMetadata,
      `${JSON.stringify(
        {
          schema: "iva-owner-tenant-migration/v1",
          migrationId,
          tenantId: plan.tenantId,
          sourceVault: plan.sourceVault,
          archivedSource,
          targetVault: plan.targetVault,
          backupVault,
          files: plan.files,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return { ...plan, migrationId, backupVault, rollbackMetadata };
  } catch (error) {
    if (archived && !existsSync(plan.sourceVault)) {
      renameSync(archivedSource, plan.sourceVault);
    }
    if (published) rmSync(plan.targetVault, { recursive: true, force: true });
    for (const name of copiedState) {
      rmSync(join(context.dataRoot, name), { force: true });
    }
    if (importedTasks) {
      if (stateExisted && existsSync(statePath)) {
        const db = new DatabaseSync(statePath);
        try {
          db.exec("DELETE FROM tasks");
        } finally {
          db.close();
        }
      } else {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${statePath}${suffix}`, { force: true });
        }
      }
    }
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
