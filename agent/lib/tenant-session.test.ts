/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TenantRegistry } from "./tenant-registry.ts";
import {
  operationalTenantId,
  withTenantStoreFromSession,
} from "./tenant-session.ts";
import { reconcileTelegramTenants } from "./telegram-tenant-provisioning.ts";

function session(userId: string) {
  const auth = {
    attributes: {},
    authenticator: "telegram-bot",
    issuer: "telegram",
    principalId: `telegram:${userId}`,
    principalType: "user",
  };
  return { session: { auth: { current: auth, initiator: auth } } };
}

test("overlapping async session operations retain separate live tenant stores", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const previousOwners = process.env.TELEGRAM_OWNER_USER_IDS;
  process.env.ASSISTANT_DATA_DIR = root;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "101,202";
  process.env.TELEGRAM_OWNER_USER_IDS = "101";
  t.after(() => {
    if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousData;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
    if (previousOwners === undefined)
      delete process.env.TELEGRAM_OWNER_USER_IDS;
    else process.env.TELEGRAM_OWNER_USER_IDS = previousOwners;
  });
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  reconcileTelegramTenants(registry);
  registry.close();

  const run = (userId: string, delay: number) =>
    withTenantStoreFromSession(session(userId), async (store) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const schemaVersion = store.withStateDatabase(
        (db) =>
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
      );
      return {
        tenantId: store.context.tenantId,
        root: store.context.dataRoot,
        schemaVersion,
      };
    });
  const [a, b] = await Promise.all([run("101", 15), run("202", 1)]);
  assert.notEqual(a.tenantId, b.tenantId);
  assert.notEqual(a.root, b.root);
  assert.equal(a.schemaVersion, 4);
  assert.equal(b.schemaVersion, 4);
});

test("only a verified scoped service principal can open its delegated tenant", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-service-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const previousOwners = process.env.TELEGRAM_OWNER_USER_IDS;
  process.env.ASSISTANT_DATA_DIR = root;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "303";
  process.env.TELEGRAM_OWNER_USER_IDS = "303";
  t.after(() => {
    if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousData;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
    if (previousOwners === undefined)
      delete process.env.TELEGRAM_OWNER_USER_IDS;
    else process.env.TELEGRAM_OWNER_USER_IDS = previousOwners;
  });
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  reconcileTelegramTenants(registry);
  const tenantId = registry.listActive()[0].tenantId;
  registry.close();

  const unscoped = {
    session: {
      auth: {
        current: {
          attributes: { tenant_id: tenantId },
          authenticator: "iva-bearer",
          issuer: "iva",
          principalId: "iva-internal-client",
          principalType: "service",
        },
        initiator: null,
      },
    },
  };
  assert.throws(
    () => withTenantStoreFromSession(unscoped, () => "should not run"),
    /Unsupported principal type/u,
  );

  const scoped = {
    session: {
      auth: {
        current: {
          attributes: {
            tenant_id: tenantId,
            tenant_grant: "verified",
            service_purpose: "memory-daily",
          },
          authenticator: "iva-tenant-grant",
          issuer: "iva",
          principalId: `tenant:${tenantId}`,
          principalType: "service",
        },
        initiator: null,
      },
    },
  };
  assert.deepEqual(
    withTenantStoreFromSession(scoped, (store) => ({
      tenantId: store.context.tenantId,
      role: store.context.role,
    })),
    { tenantId, role: "service" },
  );
});

test("operational attribution accepts authenticated opaque tenants only", () => {
  const tenantId = `t_${"a".repeat(32)}`;
  const principal = (
    authenticator: string,
    principalType: string,
    attributes: Record<string, string>,
  ) =>
    ({
      session: {
        auth: {
          current: {
            attributes,
            authenticator,
            principalId: "subject",
            principalType,
          },
          initiator: null,
        },
      },
    }) as Parameters<typeof operationalTenantId>[0];

  assert.equal(
    operationalTenantId(
      principal("telegram-bot", "user", { tenant_id: tenantId }),
    ),
    tenantId,
  );
  assert.equal(
    operationalTenantId(
      principal("iva-tenant-grant", "service", {
        tenant_id: tenantId,
        tenant_grant: "verified",
      }),
    ),
    tenantId,
  );
  assert.equal(
    operationalTenantId(
      principal("iva-bearer", "service", { tenant_id: tenantId }),
    ),
    undefined,
  );
  assert.equal(
    operationalTenantId(
      principal("telegram-bot", "user", { tenant_id: "telegram:42" }),
    ),
    undefined,
  );
});
