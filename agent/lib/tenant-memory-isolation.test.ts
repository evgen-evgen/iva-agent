/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("card add/update/supersede and search remain tenant isolated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const previousOwners = process.env.TELEGRAM_OWNER_USER_IDS;
  process.env.ASSISTANT_DATA_DIR = root;
  process.env.ASSISTANT_TIMEZONE = "UTC";
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
  const records = registry.listByAuthenticator("telegram-bot", "telegram");
  const byPrincipal = new Map(
    records.map((record) => [record.identity.externalPrincipal, record]),
  );
  registry.close();
  const vaultA = join(
    root,
    "tenants",
    byPrincipal.get("telegram:101")?.tenantId as string,
    "vault",
  );
  const vaultB = join(
    root,
    "tenants",
    byPrincipal.get("telegram:202")?.tenantId as string,
    "vault",
  );
  const toolsRoot = join(import.meta.dirname, "..", "tools");
  const writeCardModule = (await import(
    join(toolsRoot, "write_card.ts")
  )) as typeof import("../tools/write_card.ts");
  const memorySearchModule = (await import(
    join(toolsRoot, "memory_search.ts")
  )) as typeof import("../tools/memory_search.ts");
  const writeCardTool = writeCardModule.default;
  const { searchMemory } = memorySearchModule;
  type ToolResult = {
    ok: boolean;
    file?: string;
    action?: string;
    error?: string;
  };
  const execute = writeCardTool.execute.bind(writeCardTool) as unknown as (
    input: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<ToolResult>;
  const base = {
    type: "note",
    description: "tenant memory isolation",
    tags: ["isolation"],
  };
  const addedA = await execute(
    { ...base, operation: "ADD", title: "Alpha", body: "alphax731" },
    session("101"),
  );
  const addedB = await execute(
    { ...base, operation: "ADD", title: "Beta", body: "betay842" },
    session("202"),
  );
  assert.equal(addedA.ok, true, addedA.error);
  assert.equal(addedB.ok, true, addedB.error);

  const updatedA = await execute(
    {
      ...base,
      operation: "UPDATE",
      title: "Alpha",
      body: "alphaupdate953",
    },
    session("101"),
  );
  assert.equal(updatedA.ok, true, updatedA.error);
  const supersededB = await execute(
    {
      ...base,
      operation: "SUPERSEDE",
      title: "Beta",
      body: "betacurrent164",
      history_entry: "betay842",
    },
    session("202"),
  );
  assert.equal(supersededB.ok, true, supersededB.error);

  const alphaInA = await searchMemory({ query: "alphax731" }, vaultA);
  const alphaInB = await searchMemory({ query: "alphax731" }, vaultB);
  const betaInB = await searchMemory({ query: "betacurrent164" }, vaultB);
  const betaInA = await searchMemory({ query: "betacurrent164" }, vaultA);
  assert.equal(alphaInA.hits.length > 0, true);
  assert.deepEqual(alphaInB.hits, []);
  assert.equal(betaInB.hits.length > 0, true);
  assert.deepEqual(betaInA.hits, []);
  assert.equal(existsSync(join(vaultA, addedA.file as string)), true);
  assert.equal(existsSync(join(vaultB, addedA.file as string)), false);
  assert.doesNotMatch(
    readFileSync(join(vaultB, addedB.file as string), "utf8"),
    /alphax731/u,
  );
});
