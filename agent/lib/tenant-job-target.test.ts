/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations are intentionally top-level. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTenantJobTarget,
  tenantIdArgument,
} from "./tenant-job-target.ts";
import { TenantRegistry } from "./tenant-registry.ts";

test("tenant job target accepts only an opaque explicit tenant argument", () => {
  const id = `t_${"a".repeat(32)}`;
  assert.equal(tenantIdArgument(["daily", "--tenant-id", id]), id);
  assert.equal(tenantIdArgument(["--tenant-id", "telegram:42"]), null);
  assert.equal(tenantIdArgument(["--tenant-id", "../../vault"]), null);
  assert.equal(tenantIdArgument([]), null);
});

test("job target preserves the selected tenant delivery destination", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-job-target-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  });
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  const a = registry.create(
    {
      authenticator: "telegram-bot",
      issuer: "telegram",
      externalPrincipal: "telegram:101",
    },
    { telegramDestination: "chat-a" },
  );
  const b = registry.create(
    {
      authenticator: "telegram-bot",
      issuer: "telegram",
      externalPrincipal: "telegram:202",
    },
    { telegramDestination: "chat-b" },
  );
  registry.close();

  const targetA = resolveTenantJobTarget(["--tenant-id", a.tenantId]);
  const targetB = resolveTenantJobTarget(["--tenant-id", b.tenantId]);
  assert.equal(targetA.record.telegramDestination, "chat-a");
  assert.equal(targetB.record.telegramDestination, "chat-b");
  assert.notEqual(targetA.context.dataRoot, targetB.context.dataRoot);
});
