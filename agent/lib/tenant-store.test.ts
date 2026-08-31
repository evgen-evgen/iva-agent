/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TenantContext } from "./tenant-context.ts";
import { TenantStore } from "./tenant-store.ts";

function context(root: string, suffix: string): TenantContext {
  const dataRoot = join(root, `t_${suffix.repeat(32)}`);
  return Object.freeze({
    tenantId: `t_${suffix.repeat(32)}`,
    role: "user",
    dataRoot,
    vaultRoot: join(dataRoot, "vault"),
  });
}

test("two tenants receive distinct restrictive roots and state databases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = new TenantStore(context(root, "a"));
  const b = new TenantStore(context(root, "b"));
  t.after(() => {
    a.close();
    b.close();
  });

  assert.notEqual(a.context.dataRoot, b.context.dataRoot);
  assert.notEqual(a.statePath, b.statePath);
  assert.equal(statSync(a.context.dataRoot).mode & 0o777, 0o700);
  assert.equal(statSync(a.context.vaultRoot).mode & 0o777, 0o700);
  assert.equal(statSync(a.statePath).mode & 0o777, 0o600);
  assert.equal(statSync(b.statePath).mode & 0o777, 0o600);

  a.withStateDatabase((db) =>
    db
      .prepare("INSERT INTO tenant_state_meta(key, value) VALUES (?, ?)")
      .run("secret", "tenant-a"),
  );
  const aValue = a.withStateDatabase(
    (db) =>
      (
        db
          .prepare("SELECT value FROM tenant_state_meta WHERE key = ?")
          .get("secret") as { value: string }
      ).value,
  );
  const bValue = b.withStateDatabase((db) =>
    db
      .prepare("SELECT value FROM tenant_state_meta WHERE key = ?")
      .get("secret"),
  );
  assert.equal(aValue, "tenant-a");
  assert.equal(bValue, undefined);
});

test("tenant root may not be a symbolic link", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-store-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const linkedContext = context(root, "c");
  mkdirSync(target);
  symlinkSync(target, linkedContext.dataRoot);
  assert.throws(
    () => new TenantStore(linkedContext),
    /must not be a symbolic link/u,
  );
});
