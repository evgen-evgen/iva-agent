/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TenantIdentity } from "./tenant-context.ts";
import { TenantRegistry } from "./tenant-registry.ts";

function identity(id: string): TenantIdentity {
  return {
    authenticator: "telegram-bot",
    issuer: "telegram",
    externalPrincipal: `telegram:${id}`,
  };
}

function fixture(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-tenants-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "tenants.sqlite");
}

test("registry creates opaque unique tenants and preserves identity uniqueness", (t) => {
  const registry = new TenantRegistry(fixture(t));
  t.after(() => registry.close());
  const alice = registry.create(identity("101"), {
    role: "owner",
    telegramDestination: "101",
  });
  const sameAlice = registry.create(identity("101"), { role: "user" });
  const bob = registry.create(identity("202"));

  assert.match(alice.tenantId, /^t_[0-9a-f]{32}$/u);
  assert.deepEqual(sameAlice, alice);
  assert.notEqual(bob.tenantId, alice.tenantId);
  assert.equal(registry.listActive().length, 2);
});

test("registry CRUD stores role, status, and Telegram destination", (t) => {
  const registry = new TenantRegistry(fixture(t));
  t.after(() => registry.close());
  const created = registry.create(identity("101"));
  const updated = registry.update(created.tenantId, {
    role: "owner",
    status: "disabled",
    telegramDestination: "chat-101",
  });
  assert.deepEqual(registry.findByIdentity(identity("101")), updated);
  assert.equal(updated.role, "owner");
  assert.equal(updated.status, "disabled");
  assert.equal(updated.telegramDestination, "chat-101");
  assert.deepEqual(registry.listActive(), []);
});

test("registry survives restart and runs in WAL mode", (t) => {
  const path = fixture(t);
  const first = new TenantRegistry(path);
  const created = first.create(identity("101"), { role: "owner" });
  first.close();

  const second = new TenantRegistry(path);
  t.after(() => second.close());
  assert.deepEqual(second.findByIdentity(identity("101")), created);
  const inspection = new DatabaseSync(path);
  t.after(() => inspection.close());
  assert.equal(
    (
      inspection.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      }
    ).journal_mode,
    "wal",
  );
});

test("newer and incomplete registry schemas fail closed", (t) => {
  const newer = fixture(t);
  const db = new DatabaseSync(newer);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => new TenantRegistry(newer), /newer than supported/u);

  const incomplete = join(
    tmpdir(),
    `iva-tenants-incomplete-${process.pid}-${Date.now()}.sqlite`,
  );
  t.after(() => rmSync(incomplete, { force: true }));
  const broken = new DatabaseSync(incomplete);
  broken.exec("CREATE TABLE unrelated(value TEXT); PRAGMA user_version = 1");
  broken.close();
  assert.throws(() => new TenantRegistry(incomplete), /schema is incomplete/u);
});
