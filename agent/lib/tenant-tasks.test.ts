/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TenantContext } from "./tenant-context.ts";
import { TenantStore } from "./tenant-store.ts";
import { TenantTaskStore } from "./tenant-tasks.ts";

function context(root: string, marker: string): TenantContext {
  const tenantId = `t_${marker.repeat(32)}`;
  const dataRoot = join(root, tenantId);
  return Object.freeze({
    tenantId,
    role: "user",
    dataRoot,
    vaultRoot: join(dataRoot, "vault"),
  });
}

test("task IDs, lists, and mutations are independent across tenants", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-tasks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tenantA = new TenantStore(context(root, "a"));
  const tenantB = new TenantStore(context(root, "b"));
  t.after(() => {
    tenantA.close();
    tenantB.close();
  });
  const a = new TenantTaskStore(tenantA);
  const b = new TenantTaskStore(tenantB);
  const aTask = a.add({ text: "secret A", priority: "high" });
  const bTask = b.add({ text: "private B" });

  assert.equal(aTask.id, 1);
  assert.equal(bTask.id, 1);
  assert.deepEqual(
    a.list().map((item) => item.text),
    ["secret A"],
  );
  assert.deepEqual(
    b.list().map((item) => item.text),
    ["private B"],
  );
  assert.equal(a.done(1)?.done, true);
  assert.deepEqual(a.list(), []);
  assert.equal(b.list()[0]?.done, false);
  assert.equal(a.remove(999), null);
});

test("tenant tasks survive closing and reopening state.sqlite", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-tasks-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tenantContext = context(root, "c");
  const first = new TenantStore(tenantContext);
  new TenantTaskStore(first).add({ text: "survive restart", due: "tomorrow" });
  first.close();

  const second = new TenantStore(tenantContext);
  t.after(() => second.close());
  assert.deepEqual(new TenantTaskStore(second).list(), [
    {
      id: 1,
      text: "survive restart",
      priority: "med",
      due: "tomorrow",
      done: false,
      createdAt: new TenantTaskStore(second).list()[0]?.createdAt,
    },
  ]);
});
