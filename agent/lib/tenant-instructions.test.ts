/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TenantContext } from "./tenant-context.ts";
import {
  tenantCoreMarkdown,
  tenantPersonaMarkdown,
} from "./tenant-instructions.ts";
import { TenantStore } from "./tenant-store.ts";

function context(root: string, marker: string): TenantContext {
  const tenantId = `t_${marker.repeat(32)}`;
  const dataRoot = join(root, tenantId);
  return Object.freeze({
    tenantId,
    role: marker === "a" ? "owner" : "user",
    dataRoot,
    vaultRoot: join(dataRoot, "vault"),
  });
}

test("CORE and persona are loaded only from the active tenant", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-tenant-instructions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextA = context(root, "a");
  const contextB = context(root, "b");
  const storeA = new TenantStore(contextA);
  const storeB = new TenantStore(contextB);
  t.after(() => {
    storeA.close();
    storeB.close();
  });
  writeFileSync(join(contextA.vaultRoot, "CORE.md"), "owner-secret-core");
  writeFileSync(join(contextA.vaultRoot, "PERSONA.md"), "owner-custom-persona");
  writeFileSync(join(contextB.vaultRoot, "CORE.md"), "user-b-core");

  const [aCore, bCore, aPersona, bPersona] = await Promise.all([
    Promise.resolve().then(() => tenantCoreMarkdown(contextA)),
    Promise.resolve().then(() => tenantCoreMarkdown(contextB)),
    Promise.resolve().then(() => tenantPersonaMarkdown(contextA)),
    Promise.resolve().then(() => tenantPersonaMarkdown(contextB)),
  ]);
  assert.match(aCore, /owner-secret-core/u);
  assert.doesNotMatch(aCore, /user-b-core/u);
  assert.match(bCore, /user-b-core/u);
  assert.doesNotMatch(bCore, /owner-secret-core/u);
  assert.match(aPersona, /owner-custom-persona/u);
  assert.doesNotMatch(bPersona, /owner-custom-persona/u);
  assert.match(bPersona, /neutral, respectful/u);
});
