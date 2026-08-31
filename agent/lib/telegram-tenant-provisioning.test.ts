/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ownerTelegramUsers,
  validateTelegramOwnerConfiguration,
} from "./telegram-allowlist.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import {
  ensureTelegramTenant,
  reconcileTelegramTenants,
} from "./telegram-tenant-provisioning.ts";

function fixture(t: test.TestContext): TenantRegistry {
  const dir = mkdtempSync(join(tmpdir(), "iva-telegram-tenants-"));
  const registry = new TenantRegistry(join(dir, "tenants.sqlite"));
  t.after(() => {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return registry;
}

test("owner configuration contains only valid Telegram IDs", () => {
  assert.deepEqual(
    [...ownerTelegramUsers({ TELEGRAM_OWNER_USER_IDS: "101, 202" })],
    ["101", "202"],
  );
  assert.doesNotThrow(() =>
    validateTelegramOwnerConfiguration({ TELEGRAM_OWNER_USER_IDS: "101" }),
  );
  assert.throws(
    () =>
      validateTelegramOwnerConfiguration({
        TELEGRAM_OWNER_USER_IDS: "not-an-id",
      }),
    /Invalid Telegram owner ID/u,
  );
});

test("a first-time private sender becomes an ordinary active tenant", (t) => {
  const registry = fixture(t);
  const record = ensureTelegramTenant(registry, "202", {
    TELEGRAM_OWNER_USER_IDS: "101",
  });
  assert.equal(record.role, "user");
  assert.equal(record.status, "active");
  assert.equal(record.telegramDestination, "202");
  assert.equal(
    registry.listByAuthenticator("telegram-bot", "telegram")[0]?.identity
      .externalPrincipal,
    "telegram:202",
  );
});

test("owner reconciliation changes roles without disabling users", (t) => {
  const registry = fixture(t);
  const first = ensureTelegramTenant(registry, "101", {
    TELEGRAM_OWNER_USER_IDS: "101",
  });
  const second = ensureTelegramTenant(registry, "202", {
    TELEGRAM_OWNER_USER_IDS: "101",
  });
  registry.update(second.tenantId, { status: "disabled" });
  reconcileTelegramTenants(registry, { TELEGRAM_OWNER_USER_IDS: "202" });
  assert.equal(registry.get(first.tenantId)?.role, "user");
  assert.equal(registry.get(first.tenantId)?.status, "active");
  assert.equal(registry.get(second.tenantId)?.role, "owner");
  assert.equal(registry.get(second.tenantId)?.status, "disabled");
});

test("a returning sender is reactivated with the same tenant ID", (t) => {
  const registry = fixture(t);
  const first = ensureTelegramTenant(registry, "303");
  registry.update(first.tenantId, { status: "disabled" });
  const returned = ensureTelegramTenant(registry, "303");
  assert.equal(returned.tenantId, first.tenantId);
  assert.equal(returned.status, "active");
});
