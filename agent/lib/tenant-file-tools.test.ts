/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import globTool from "../tools/glob.ts";
import grepTool from "../tools/grep.ts";
import readFileTool from "../tools/read_file.ts";
import writeFileTool from "../tools/write_file.ts";
import { tenantContextFromSession } from "./tenant-session.ts";
import { TenantStore } from "./tenant-store.ts";
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

type Execute = (
  input: Record<string, unknown>,
  context: ReturnType<typeof session>,
) => Promise<unknown>;

const executeRead = readFileTool.execute.bind(
  readFileTool,
) as unknown as Execute;
const executeWrite = writeFileTool.execute.bind(
  writeFileTool,
) as unknown as Execute;
const executeGrep = grepTool.execute.bind(grepTool) as unknown as Execute;
const executeGlob = globTool.execute.bind(globTool) as unknown as Execute;

function rejectionMessage(error: unknown): string {
  assert.ok(error instanceof Error);
  return error.message;
}

test("model-facing file tools are tenant-relative and hide physical paths", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-file-tools-"));
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
  const sessionA = session("101");
  const sessionB = session("202");
  const tenantA = tenantContextFromSession(sessionA);
  const tenantB = tenantContextFromSession(sessionB);
  new TenantStore(tenantA).close();
  new TenantStore(tenantB).close();

  await executeWrite(
    { path: "notes/shared.md", content: "alpha-file-secret" },
    sessionA,
  );
  await executeWrite(
    { path: "notes/shared.md", content: "beta-file-secret" },
    sessionB,
  );
  writeFileSync(join(tenantA.vaultRoot, ".env"), "hidden-alpha", {
    mode: 0o600,
  });
  symlinkSync(tenantA.vaultRoot, join(tenantB.vaultRoot, "escape"));

  const ownRead = (await executeRead(
    { path: "notes/shared.md" },
    sessionB,
  )) as { content: string; path: string };
  assert.equal(ownRead.path, "notes/shared.md");
  assert.equal(ownRead.content, "beta-file-secret");

  const grep = (await executeGrep(
    { pattern: "beta-file-secret" },
    sessionB,
  )) as { matches: Array<{ file: string; text: string }> };
  assert.deepEqual(grep.matches, [
    {
      file: "notes/shared.md",
      text: "beta-file-secret",
      line: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(grep), /alpha-file-secret|tenants\/t_/u);

  const glob = (await executeGlob(
    { pattern: "**/*.md" },
    sessionB,
  )) as string[];
  assert.deepEqual(glob, ["notes/shared.md"]);
  assert.equal(
    glob.some((path) => path.startsWith("/")),
    false,
  );

  const unsafe = [
    "/etc/passwd",
    ".env",
    `../${tenantA.tenantId}/vault/notes/shared.md`,
    "escape/notes/shared.md",
  ];
  const messages: string[] = [];
  for (const path of unsafe) {
    await assert.rejects(executeRead({ path }, sessionB), (error) => {
      messages.push(rejectionMessage(error));
      return true;
    });
  }
  assert.deepEqual(
    [...new Set(messages)],
    ["Path is outside the tenant storage boundary"],
  );
  await assert.rejects(
    executeWrite({ path: "escape/forged.md", content: "forged" }, sessionB),
    /Path is outside the tenant storage boundary/u,
  );
  await assert.rejects(
    executeGlob({ pattern: "../**/*" }, sessionB),
    /Path is outside the tenant storage boundary/u,
  );
  await assert.rejects(
    executeGrep({ pattern: "secret", glob: ".env" }, sessionB),
    /Path is outside the tenant storage boundary/u,
  );
});
