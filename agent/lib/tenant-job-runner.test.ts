/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations are intentionally top-level. */
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
import { TenantRegistry } from "./tenant-registry.ts";
import { runActiveTenantJobs } from "./tenant-job-runner.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-jobs-"));
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  const create = (principal: string) =>
    registry.create({
      authenticator: "telegram-bot",
      issuer: "telegram",
      externalPrincipal: `telegram:${principal}`,
    });
  return { root, registry, a: create("101"), b: create("202") };
}

test("active tenants run with bounded concurrency and isolated cursors", async (t) => {
  const { root, registry, a, b } = fixture();
  t.after(() => registry.close());
  let active = 0;
  let peak = 0;
  const seenRoots = new Map<string, string>();

  const results = await runActiveTenantJobs({
    registry,
    tenantsRoot: join(root, "tenants"),
    jobName: "memory-daily",
    concurrency: 1,
    run: async (context) => {
      active += 1;
      peak = Math.max(peak, active);
      seenRoots.set(context.tenantId, context.vaultRoot);
      mkdirSync(join(context.vaultRoot, ".graph"), { recursive: true });
      writeFileSync(
        join(context.vaultRoot, ".graph", "fixture.json"),
        JSON.stringify({ tenantId: context.tenantId }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (context.tenantId === a.tenantId) throw new Error("tenant A failed");
    },
  });

  assert.equal(peak, 1);
  assert.deepEqual(
    results.map(({ tenantId, status }) => ({ tenantId, status })),
    [
      { tenantId: a.tenantId, status: "failed" },
      { tenantId: b.tenantId, status: "succeeded" },
    ],
  );
  assert.notEqual(seenRoots.get(a.tenantId), seenRoots.get(b.tenantId));
  assert.equal(
    existsSync(join(root, "tenants", a.tenantId, "vault/.graph/fixture.json")),
    true,
  );
  assert.equal(
    existsSync(join(root, "tenants", b.tenantId, "vault/.graph/fixture.json")),
    true,
  );
  assert.equal(
    existsSync(join(root, "tenants", a.tenantId, "vault", b.tenantId)),
    false,
  );
  for (const { tenantId, status } of results) {
    const cursor = JSON.parse(
      readFileSync(
        join(root, "tenants", tenantId, "runtime/jobs/memory-daily.json"),
        "utf8",
      ),
    ) as { tenantId: string; status: string };
    assert.equal(cursor.tenantId, tenantId);
    assert.equal(cursor.status, status);
  }
});

test("a tenant lock skips only that tenant", async (t) => {
  const { root, registry, a, b } = fixture();
  t.after(() => registry.close());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const first = runActiveTenantJobs({
    registry: { listActive: () => [a] },
    tenantsRoot: join(root, "tenants"),
    jobName: "brain",
    run: async () => {
      enteredResolve();
      await held;
    },
  });
  await entered;

  const second = await runActiveTenantJobs({
    registry,
    tenantsRoot: join(root, "tenants"),
    jobName: "brain",
    run: () => Promise.resolve(),
  });
  release();
  await first;

  assert.equal(
    second.find((result) => result.tenantId === a.tenantId)?.status,
    "locked",
  );
  assert.equal(
    second.find((result) => result.tenantId === b.tenantId)?.status,
    "succeeded",
  );
});
