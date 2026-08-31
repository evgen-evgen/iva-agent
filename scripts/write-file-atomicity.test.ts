/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tenantContextFromSession } from "../agent/lib/tenant-session.ts";
import { TenantStore } from "../agent/lib/tenant-store.ts";
import { TenantRegistry } from "../agent/lib/tenant-registry.ts";
import { reconcileTelegramTenants } from "../agent/lib/telegram-tenant-provisioning.ts";
import writeFileTool from "../agent/tools/write_file.ts";

const SIZE = 1024 * 1024;

test("write_file atomically publishes CORE.md inside the tenant vault", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "iva-write-file-atomicity-"));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const previousOwners = process.env.TELEGRAM_OWNER_USER_IDS;
  process.env.ASSISTANT_DATA_DIR = directory;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "101";
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
  const auth = {
    attributes: {},
    authenticator: "telegram-bot",
    issuer: "telegram",
    principalId: "telegram:101",
    principalType: "user",
  } as const;
  const session = { session: { auth: { current: auth, initiator: auth } } };
  const registry = new TenantRegistry(join(directory, "tenants.sqlite"));
  reconcileTelegramTenants(registry);
  registry.close();
  const tenant = tenantContextFromSession(session);
  new TenantStore(tenant).close();
  const file = join(tenant.vaultRoot, "CORE.md");
  const after = "B".repeat(SIZE);
  writeFileSync(file, "before");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = (await writeFileTool.execute(
    { path: "CORE.md", content: after },
    session as never,
  )) as { ok: boolean; bytes: number };
  assert.deepEqual(result, {
    ok: true,
    path: "CORE.md",
    bytes: SIZE,
  });
  assert.equal(readFileSync(file, "utf8"), after);
  assert.equal(
    readFileSync(file, "utf8").length,
    SIZE,
    "published file must contain the complete payload",
  );
});
