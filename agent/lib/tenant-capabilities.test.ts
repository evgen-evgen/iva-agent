/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bashDynamic, { bashTool } from "../tools/bash.ts";
import connectionSearchDynamic from "../tools/connection_search.ts";
import userbotConnection from "../connections/telegram-userbot.ts";
import {
  OWNER_ONLY_TOOLS,
  tenantCapabilityProfile,
  TENANT_SAFE_TOOLS,
  toolAllowedForProfile,
} from "./tenant-capabilities.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import { reconcileTelegramTenants } from "./telegram-tenant-provisioning.ts";

function session(userId: string) {
  const auth = {
    attributes: {},
    authenticator: "telegram-bot",
    issuer: "telegram",
    principalId: `telegram:${userId}`,
    principalType: "user",
  };
  return { session: { auth: { current: auth, initiator: auth } } } as never;
}

type Dynamic = {
  events: Record<string, (event: unknown, context: never) => unknown>;
};

test("telegram-user and telegram-owner receive separate capability profiles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-capabilities-"));
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
  const owner = session("101");
  const user = session("202");

  assert.equal(tenantCapabilityProfile(owner), "telegram-owner");
  assert.equal(tenantCapabilityProfile(user), "telegram-user");
  for (const tool of TENANT_SAFE_TOOLS) {
    assert.equal(toolAllowedForProfile("telegram-user", tool), true, tool);
  }
  for (const tool of OWNER_ONLY_TOOLS) {
    assert.equal(toolAllowedForProfile("telegram-user", tool), false, tool);
    assert.equal(toolAllowedForProfile("telegram-owner", tool), true, tool);
  }
  for (const forbidden of [
    "bash",
    "connection_search",
    "plugin_admin",
    "telegram-userbot",
  ]) {
    assert.equal(
      toolAllowedForProfile("telegram-user", forbidden),
      false,
      forbidden,
    );
  }

  const bashEvents = (bashDynamic as unknown as Dynamic).events;
  assert.equal(bashEvents["turn.started"]({}, user), null);
  assert.equal(bashEvents["turn.started"]({}, owner), bashTool);
  const connectionEvents = (connectionSearchDynamic as unknown as Dynamic)
    .events;
  assert.deepEqual(connectionEvents["turn.started"]({}, user), {
    kind: "eve:disabled-tool",
  });
  assert.equal(connectionEvents["turn.started"]({}, owner), null);
});

test("direct forged privileged calls are denied at execution time", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-owner-execution-"));
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
  const user = session("202");
  const owner = session("101");

  await assert.rejects(
    async () =>
      await bashTool.execute({ command: "printf should-not-run" }, user),
    /restricted to the installation owner/u,
  );
  assert.equal(typeof userbotConnection.auth, "function");
  const resolveAuth = userbotConnection.auth as (context: never) => unknown;
  assert.throws(
    () => resolveAuth(user),
    /restricted to the installation owner/u,
  );
  assert.doesNotThrow(() => resolveAuth(owner));
});
