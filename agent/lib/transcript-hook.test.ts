/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-transcript-hook-"));
process.env.ASSISTANT_DATA_DIR = root;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.TELEGRAM_ALLOWED_USER_IDS = "101,202";
process.env.TELEGRAM_OWNER_USER_IDS = "101";

const { TenantRegistry } = await import("./tenant-registry.ts");
const { reconcileTelegramTenants } =
  await import("./telegram-tenant-provisioning.ts");
const { persistCompletedAssistantTranscript } =
  await import("./transcript-persistence.ts");

function session(userId: string) {
  const auth = {
    attributes: {},
    authenticator: "telegram-bot",
    issuer: "telegram",
    principalId: `telegram:${userId}`,
    principalType: "user",
  };
  return {
    session: {
      id: `session-${userId}`,
      auth: { current: auth, initiator: auth },
      turn: { id: `turn-${userId}` },
    },
  } as never;
}

function transcript(tenantId: string): string {
  const daily = join(root, "tenants", tenantId, "vault", "daily");
  return readdirSync(daily)
    .map((name) => readFileSync(join(daily, name), "utf8"))
    .join("\n");
}

test("completed assistant responses persist only to their authenticated tenant", (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  reconcileTelegramTenants(registry);
  const records = registry.listByAuthenticator("telegram-bot", "telegram");
  const ids = new Map(
    records.map((record) => [
      record.identity.externalPrincipal,
      record.tenantId,
    ]),
  );
  registry.close();

  persistCompletedAssistantTranscript(
    { finishReason: "stop", message: "assistant-secret-a" },
    session("101"),
  );
  persistCompletedAssistantTranscript(
    { finishReason: "stop", message: "assistant-secret-b" },
    session("202"),
  );

  const a = transcript(ids.get("telegram:101") as string);
  const b = transcript(ids.get("telegram:202") as string);
  assert.match(a, /assistant-secret-a/u);
  assert.doesNotMatch(a, /assistant-secret-b/u);
  assert.match(b, /assistant-secret-b/u);
  assert.doesNotMatch(b, /assistant-secret-a/u);
});
