import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantContext } from "./tenant-context.ts";

const TENANT_ID = /^t_[0-9a-f]{32}$/u;
const SCOPE =
  /<!-- iva-tenant-scope:v1\.(t_[0-9a-f]{32})\.([A-Za-z0-9_-]+) -->/u;

function signature(secret: string, tenantId: string): Buffer {
  return createHmac("sha256", secret)
    .update(`provider-scope:v1:${tenantId}`)
    .digest();
}

export function tenantProviderScopeMarkdown(
  context: TenantContext,
  secret = process.env.ASSISTANT_BEARER ?? "",
): string {
  if (!secret || !TENANT_ID.test(context.tenantId)) return "";
  return `<!-- iva-tenant-scope:v1.${context.tenantId}.${signature(
    secret,
    context.tenantId,
  ).toString("base64url")} -->`;
}

export function tenantIdFromProviderScope(
  markdown: string,
  secret = process.env.ASSISTANT_BEARER ?? "",
): string | null {
  if (!secret) return null;
  const match = SCOPE.exec(markdown);
  if (!match) return null;
  const received = Buffer.from(match[2], "base64url");
  const expected = signature(secret, match[1]);
  if (
    received.byteLength !== expected.byteLength ||
    !timingSafeEqual(received, expected)
  ) {
    return null;
  }
  return match[1];
}
