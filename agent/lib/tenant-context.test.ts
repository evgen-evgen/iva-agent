/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeTenantIdentity,
  resolveTenantContext,
  TenantResolutionError,
  type TenantIdentity,
  type TenantLookup,
  type TenantRecord,
} from "./tenant-context.ts";

const TENANT_A: TenantRecord = {
  tenantId: "t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  role: "owner",
  status: "active",
  telegramDestination: "101",
};
const TENANT_B: TenantRecord = {
  tenantId: "t_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  role: "user",
  status: "active",
  telegramDestination: "202",
};

class MemoryLookup implements TenantLookup {
  readonly #records = new Map<string, TenantRecord>();

  constructor(entries: Array<[TenantIdentity, TenantRecord]>) {
    for (const [identity, record] of entries) {
      const normalized = normalizeTenantIdentity(identity);
      this.#records.set(JSON.stringify(normalized), record);
    }
  }

  findByIdentity(identity: TenantIdentity): TenantRecord | null {
    return (
      this.#records.get(JSON.stringify(normalizeTenantIdentity(identity))) ??
      null
    );
  }
}

const lookup = new MemoryLookup([
  [
    {
      authenticator: "telegram-bot",
      issuer: "telegram",
      externalPrincipal: "telegram:101",
    },
    TENANT_A,
  ],
  [
    {
      authenticator: "telegram-bot",
      issuer: "telegram",
      externalPrincipal: "telegram:202",
    },
    TENANT_B,
  ],
]);

function principal(id: string) {
  return {
    authenticator: " Telegram-Bot ",
    issuer: " TELEGRAM ",
    principalId: `telegram:${id}`,
    principalType: "user",
  } as const;
}

test("the same authenticated user resolves to one stable frozen tenant", () => {
  const first = resolveTenantContext(
    lookup,
    principal("101"),
    "/srv/iva/tenants",
  );
  const second = resolveTenantContext(
    lookup,
    principal("101"),
    "/srv/iva/tenants",
  );
  assert.deepEqual(first, second);
  assert.equal(first.tenantId, TENANT_A.tenantId);
  assert.equal(first.dataRoot, join("/srv/iva/tenants", TENANT_A.tenantId));
  assert.equal(Object.isFrozen(first), true);
});

test("different users resolve to different roots and tenant IDs", () => {
  const first = resolveTenantContext(
    lookup,
    principal("101"),
    "/srv/iva/tenants",
  );
  const second = resolveTenantContext(
    lookup,
    principal("202"),
    "/srv/iva/tenants",
  );
  assert.notEqual(first.tenantId, second.tenantId);
  assert.notEqual(first.dataRoot, second.dataRoot);
  assert.notEqual(first.vaultRoot, second.vaultRoot);
});

test("missing, service, malformed, unknown, and disabled principals fail closed", () => {
  const disabledLookup = new MemoryLookup([
    [
      {
        authenticator: "telegram-bot",
        issuer: "telegram",
        externalPrincipal: "telegram:303",
      },
      { ...TENANT_B, status: "disabled" },
    ],
  ]);
  const cases = [
    null,
    { ...principal("101"), principalType: "service" },
    { ...principal("101"), authenticator: "../telegram" },
    principal("999"),
  ];
  for (const candidate of cases) {
    assert.throws(
      () => resolveTenantContext(lookup, candidate, "/srv/iva/tenants"),
      TenantResolutionError,
    );
  }
  assert.throws(
    () =>
      resolveTenantContext(
        disabledLookup,
        principal("303"),
        "/srv/iva/tenants",
      ),
    TenantResolutionError,
  );
});

test("overlapping resolutions retain their own immutable tenant context", async () => {
  const [a, b, againA] = await Promise.all([
    Promise.resolve().then(() =>
      resolveTenantContext(lookup, principal("101"), "/srv/iva/tenants"),
    ),
    Promise.resolve().then(() =>
      resolveTenantContext(lookup, principal("202"), "/srv/iva/tenants"),
    ),
    Promise.resolve().then(() =>
      resolveTenantContext(lookup, principal("101"), "/srv/iva/tenants"),
    ),
  ]);
  assert.equal(a.tenantId, againA.tenantId);
  assert.notEqual(a.tenantId, b.tenantId);
  assert.equal(a.role, "owner");
  assert.equal(b.role, "user");
});
