import { createHash, timingSafeEqual } from "node:crypto";
import {
  extractBearerToken,
  localDev,
  placeholderAuth,
  vercelOidc,
  type AuthFn,
} from "eve/channels/auth";
import {
  TENANT_GRANT_HEADER,
  verifyTenantServiceGrant,
} from "./tenant-service-grant.ts";

const SERVICE_AUTH = {
  attributes: {},
  authenticator: "iva-bearer",
  principalId: "iva-internal-client",
  principalType: "service",
} as const;

function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Authenticate Iva's internal Eve clients with the shared bearer from `.env`. */
export function assistantBearerAuth(expectedToken?: string): AuthFn<Request> {
  const expected = expectedToken?.trim();
  return (request) => {
    if (!expected) return null;
    const received = extractBearerToken(request.headers.get("authorization"));
    if (!received || !equalSecret(received, expected)) return null;
    const encodedGrant = request.headers.get(TENANT_GRANT_HEADER);
    if (encodedGrant === null) return SERVICE_AUTH;
    const grant = verifyTenantServiceGrant(expected, encodedGrant);
    if (grant === null) return null;
    return {
      attributes: {
        tenant_id: grant.tenantId,
        tenant_grant: "verified",
        service_purpose: grant.purpose,
      },
      authenticator: "iva-tenant-grant",
      issuer: "iva",
      principalId: `tenant:${grant.tenantId}`,
      principalType: "service",
    };
  };
}

type EveAuthEnvironment = {
  readonly ASSISTANT_BEARER?: string;
  readonly EVE_DEV?: string;
};

export function createEveAuth(env: EveAuthEnvironment = process.env) {
  return [
    assistantBearerAuth(env.ASSISTANT_BEARER),
    vercelOidc(),
    // Eve sets EVE_DEV=1 itself. Production never trusts the request Host as authentication.
    ...(env.EVE_DEV === "1" ? [localDev()] : []),
    placeholderAuth(),
  ];
}
