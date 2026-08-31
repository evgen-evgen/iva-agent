/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { routeAuth } from "eve/channels/auth";
import { assistantBearerAuth, createEveAuth } from "./eve-auth.ts";
import {
  createTenantServiceGrant,
  TENANT_GRANT_HEADER,
} from "./tenant-service-grant.ts";

const TOKEN = randomBytes(32).toString("base64url");
const request = (host: string, token?: string) =>
  new Request(`http://${host}/eve/v1/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const tenantRequest = (token: string, grant: string, bodyTenant?: string) =>
  new Request("http://internal/eve/v1/session", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      [TENANT_GRANT_HEADER]: grant,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tenantId: bodyTenant }),
  });

test("bearer auth accepts only the configured secret", async () => {
  const auth = assistantBearerAuth(TOKEN);
  assert.equal(await auth(request("evil.example")), null);
  assert.equal(await auth(request("evil.example", "wrong")), null);
  assert.deepEqual(await auth(request("evil.example", TOKEN)), {
    attributes: {},
    authenticator: "iva-bearer",
    principalId: "iva-internal-client",
    principalType: "service",
  });
});

test("a signed service grant scopes auth independently of request payload", async () => {
  const tenantId = "t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const grant = createTenantServiceGrant(TOKEN, tenantId, "memory-daily");
  const auth = assistantBearerAuth(TOKEN);
  assert.deepEqual(
    await auth(
      tenantRequest(TOKEN, grant, "t_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ),
    {
      attributes: {
        tenant_id: tenantId,
        tenant_grant: "verified",
        service_purpose: "memory-daily",
      },
      authenticator: "iva-tenant-grant",
      issuer: "iva",
      principalId: `tenant:${tenantId}`,
      principalType: "service",
    },
  );
});

test("tampered and expired service grants fail authentication", async () => {
  const tenantId = "t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const auth = assistantBearerAuth(TOKEN);
  const valid = createTenantServiceGrant(TOKEN, tenantId, "digest");
  assert.equal(await auth(tenantRequest(TOKEN, `${valid}tampered`)), null);
  const expired = createTenantServiceGrant(TOKEN, tenantId, "digest", {
    now: 1_000,
    ttlMs: 1,
  });
  assert.equal(await auth(tenantRequest(TOKEN, expired)), null);
});

test("production auth rejects a spoofed loopback Host without a bearer", async () => {
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});

/** Makes the process the dev server eve 0.30's localDev() looks for, then restores it. */
const runningEveDev = (t: TestContext): void => {
  const previous = process.env.EVE_DEV;
  process.env.EVE_DEV = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = previous;
  });
};

test("eve dev keeps localDev auth explicitly", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN, EVE_DEV: "1" }),
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result.authenticator, "local-dev");
});

test("our own gate drops localDev even on a dev-server process", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});
