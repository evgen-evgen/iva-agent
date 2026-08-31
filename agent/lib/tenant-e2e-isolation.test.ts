/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations are top-level. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantRegistry } from "./tenant-registry.ts";
import { reconcileTelegramTenants } from "./telegram-tenant-provisioning.ts";
import { tenantContextFromSession } from "./tenant-session.ts";
import { TenantStore } from "./tenant-store.ts";
import { TenantTaskStore } from "./tenant-tasks.ts";
import { LocalBlobStore, BlobNotFoundError } from "./blob-store.ts";
import { appendDaily } from "./vault-daily.ts";
import { persistCompletedAssistantTranscript } from "./transcript-persistence.ts";
import { tenantCoreMarkdown } from "./tenant-instructions.ts";
import { searchMemory } from "../tools/memory_search.ts";

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

test("simultaneous tenant lifecycles never expose tenant A's unique secret to B", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = {
    data: process.env.ASSISTANT_DATA_DIR,
    allowed: process.env.TELEGRAM_ALLOWED_USER_IDS,
    owners: process.env.TELEGRAM_OWNER_USER_IDS,
  };
  process.env.ASSISTANT_DATA_DIR = root;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "101,202";
  process.env.TELEGRAM_OWNER_USER_IDS = "101";
  t.after(() => {
    if (previous.data === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous.data;
    if (previous.allowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previous.allowed;
    if (previous.owners === undefined)
      delete process.env.TELEGRAM_OWNER_USER_IDS;
    else process.env.TELEGRAM_OWNER_USER_IDS = previous.owners;
  });
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  reconcileTelegramTenants(registry);
  registry.close();

  const sessionA = session("101");
  const sessionB = session("202");
  const contextA = tenantContextFromSession(sessionA);
  const contextB = tenantContextFromSession(sessionB);
  const secretA = "copperwillowx731";
  const secretB = "silverreedy842";

  let storeA = new TenantStore(contextA);
  let storeB = new TenantStore(contextB);
  const [attachmentA] = await Promise.all([
    Promise.resolve().then(() => {
      writeFileSync(join(contextA.vaultRoot, "CORE.md"), secretA);
      appendDaily(contextA.vaultRoot, "[user]", secretA);
      new TenantTaskStore(storeA).add({ text: secretA });
      return new LocalBlobStore(storeA).save(Buffer.from(secretA));
    }),
    Promise.resolve().then(() => {
      writeFileSync(join(contextB.vaultRoot, "CORE.md"), secretB);
      appendDaily(contextB.vaultRoot, "[user]", secretB);
      new TenantTaskStore(storeB).add({ text: secretB });
      new LocalBlobStore(storeB).save(Buffer.from(secretB));
    }),
  ]);
  persistCompletedAssistantTranscript(
    { finishReason: "stop", message: `reply ${secretA}` },
    sessionA,
  );
  persistCompletedAssistantTranscript(
    { finishReason: "stop", message: `reply ${secretB}` },
    sessionB,
  );
  mkdirSync(join(contextB.vaultRoot, "cards/notes"), { recursive: true });
  writeFileSync(
    join(contextB.vaultRoot, "cards/notes/b.md"),
    `---\ntype: note\nname: B\nstatus: active\n---\n\n${secretB}\n`,
  );

  assert.throws(
    () => new LocalBlobStore(storeB).read(attachmentA.id),
    BlobNotFoundError,
  );
  storeA.close();
  storeB.close();

  // Process/session restart: reopen durable stores and resolve the same roots again.
  storeA = new TenantStore(tenantContextFromSession(sessionA));
  storeB = new TenantStore(tenantContextFromSession(sessionB));
  t.after(() => {
    storeA.close();
    storeB.close();
  });
  const searchAFromB = await searchMemory(
    { query: secretA },
    contextB.vaultRoot,
  );
  const searchB = await searchMemory({ query: secretB }, contextB.vaultRoot);
  const observableB = JSON.stringify({
    core: tenantCoreMarkdown(contextB),
    tasks: new TenantTaskStore(storeB).list(true),
    searchAFromB,
    searchB,
    transcript: readdirSync(join(contextB.vaultRoot, "daily"))
      .filter((name) => name.endsWith(".md"))
      .map((name) =>
        readFileSync(join(contextB.vaultRoot, "daily", name), "utf8"),
      )
      .join("\n"),
  });
  assert.doesNotMatch(observableB, new RegExp(secretA, "u"));
  assert.match(observableB, new RegExp(secretB, "u"));
  assert.deepEqual(searchAFromB.hits, []);
  assert.ok(searchB.hits.length > 0);
  assert.equal(new TenantTaskStore(storeA).list(true)[0]?.text, secretA);
});
