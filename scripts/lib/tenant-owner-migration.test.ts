/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations are top-level. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantRegistry } from "../../agent/lib/tenant-registry.ts";
import { tenantContextForRecord } from "../../agent/lib/tenant-context.ts";
import { TenantStore } from "../../agent/lib/tenant-store.ts";
import { TenantTaskStore } from "../../agent/lib/tenant-tasks.ts";
import {
  applyOwnerMigration,
  planOwnerMigration,
} from "./tenant-owner-migration.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "iva-owner-migration-"));
  const dataDir = join(root, "data");
  const sourceVault = join(root, "vault");
  mkdirSync(join(sourceVault, "daily"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(sourceVault, "CORE.md"), "owner secret\n");
  writeFileSync(join(sourceVault, "daily/2026-08-29.md"), "day\n");
  writeFileSync(join(dataDir, "settings.json"), '{"language":"ru"}\n');
  writeFileSync(
    join(dataDir, "tasks.json"),
    JSON.stringify([
      {
        id: 7,
        text: "keep me",
        priority: "high",
        due: null,
        done: false,
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    ]),
  );
  const registry = new TenantRegistry(join(dataDir, "tenants.sqlite"));
  const createOwner = (principal: string) =>
    registry.create(
      {
        authenticator: "telegram-bot",
        issuer: "telegram",
        externalPrincipal: `telegram:${principal}`,
      },
      { role: "owner", telegramDestination: principal },
    );
  return { root, dataDir, sourceVault, registry, createOwner };
}

test("dry-run refuses ambiguous owners without touching the legacy vault", (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  f.createOwner("101");
  f.createOwner("202");
  const before = readFileSync(join(f.sourceVault, "CORE.md"), "utf8");

  assert.throws(
    () =>
      planOwnerMigration({
        registry: f.registry,
        dataDir: f.dataDir,
        sourceVault: f.sourceVault,
      }),
    /exactly one active owner; found 2/u,
  );
  assert.equal(readFileSync(join(f.sourceVault, "CORE.md"), "utf8"), before);
  assert.equal(existsSync(join(f.dataDir, "tenants")), false);
});

test("owner migration verifies vault, imports compatible state, and records rollback", (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  const owner = f.createOwner("101");
  const plan = planOwnerMigration({
    registry: f.registry,
    dataDir: f.dataDir,
    sourceVault: f.sourceVault,
  });
  assert.equal(plan.files.length, 2);
  assert.deepEqual(plan.structuredState, ["settings.json", "tasks.json"]);
  assert.equal(existsSync(plan.targetVault), false);

  const result = applyOwnerMigration({
    registry: f.registry,
    dataDir: f.dataDir,
    sourceVault: f.sourceVault,
  });
  assert.equal(
    readFileSync(join(result.targetVault, "CORE.md"), "utf8"),
    "owner secret\n",
  );
  assert.equal(
    readFileSync(join(result.backupVault, "CORE.md"), "utf8"),
    "owner secret\n",
  );
  assert.equal(existsSync(f.sourceVault), false);
  assert.equal(existsSync(result.rollbackMetadata), true);

  const context = tenantContextForRecord(owner, join(f.dataDir, "tenants"));
  const store = new TenantStore(context);
  try {
    assert.equal(new TenantTaskStore(store).list()[0]?.id, 7);
    assert.equal(new TenantTaskStore(store).list()[0]?.text, "keep me");
  } finally {
    store.close();
  }
  assert.equal(
    readFileSync(join(context.dataRoot, "settings.json"), "utf8"),
    '{"language":"ru"}\n',
  );
});

test("an injected failure restores the source and removes unpublished tenant data", (t) => {
  const f = fixture();
  t.after(() => f.registry.close());
  const owner = f.createOwner("101");
  const context = tenantContextForRecord(owner, join(f.dataDir, "tenants"));

  assert.throws(
    () =>
      applyOwnerMigration({
        registry: f.registry,
        dataDir: f.dataDir,
        sourceVault: f.sourceVault,
        failAt: "after-source-archive",
      }),
    /Injected migration failure/u,
  );
  assert.equal(
    readFileSync(join(f.sourceVault, "CORE.md"), "utf8"),
    "owner secret\n",
  );
  assert.equal(existsSync(context.vaultRoot), false);
  if (existsSync(join(context.dataRoot, "state.sqlite"))) {
    const store = new TenantStore(context);
    try {
      assert.deepEqual(new TenantTaskStore(store).list(true), []);
    } finally {
      store.close();
    }
  }
  assert.equal(existsSync(join(context.dataRoot, "settings.json")), false);
});
