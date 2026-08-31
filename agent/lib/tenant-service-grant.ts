import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const TENANT_GRANT_HEADER = "x-iva-tenant-grant";
const MAX_TTL_MS = 60 * 60 * 1000;
const TENANT_ID = /^t_[0-9a-f]{32}$/u;

type GrantPayload = {
  readonly tenantId: string;
  readonly purpose: string;
  readonly expiresAt: number;
  readonly nonce: string;
};

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

function purpose(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error("Invalid tenant grant purpose");
  }
  return normalized;
}

export function createTenantServiceGrant(
  secret: string,
  tenantId: string,
  grantPurpose: string,
  options: { readonly now?: number; readonly ttlMs?: number } = {},
): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant ID");
  if (!secret) throw new Error("Missing service grant secret");
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new Error("Invalid tenant grant TTL");
  }
  const payload: GrantPayload = {
    tenantId,
    purpose: purpose(grantPurpose),
    expiresAt: now + ttlMs,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `v1.${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

export function verifyTenantServiceGrant(
  secret: string,
  grant: string,
  now = Date.now(),
): GrantPayload | null {
  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !secret) return null;
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  const expectedSignature = signature(secret, parts[1]);
  if (
    receivedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Partial<GrantPayload>;
  if (
    typeof candidate.tenantId !== "string" ||
    !TENANT_ID.test(candidate.tenantId) ||
    typeof candidate.purpose !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(candidate.purpose) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt <= now ||
    candidate.expiresAt > now + MAX_TTL_MS ||
    typeof candidate.nonce !== "string" ||
    candidate.nonce.length < 16
  ) {
    return null;
  }
  return candidate as GrantPayload;
}
