import type { SessionContext } from "eve/tools";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  resolveTenantContext,
  tenantContextForRecord,
  TenantResolutionError,
  type TenantContext,
} from "./tenant-context.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import { TenantStore } from "./tenant-store.ts";

export type TenantSessionContext = {
  readonly session: {
    readonly auth: SessionContext["session"]["auth"];
  };
};

const OPAQUE_TENANT_ID = /^t_[0-9a-f]{32}$/u;

/** Opaque attribution for shared operational logs; never resolves user content. */
export function operationalTenantId(
  session: TenantSessionContext,
): string | undefined {
  const principal = session.session.auth?.current;
  const candidate = principal?.attributes.tenant_id;
  if (typeof candidate !== "string" || !OPAQUE_TENANT_ID.test(candidate)) {
    return undefined;
  }
  if (
    principal?.principalType === "user" &&
    principal.authenticator === "telegram-bot"
  ) {
    return candidate;
  }
  if (
    principal?.principalType === "service" &&
    principal.authenticator === "iva-tenant-grant" &&
    principal.attributes.tenant_grant === "verified"
  ) {
    return candidate;
  }
  return undefined;
}

export function tenantContextFromSession(
  session: TenantSessionContext,
): TenantContext {
  const root = dataDir();
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  try {
    const principal = session.session.auth.current;
    if (
      principal?.principalType === "service" &&
      principal.authenticator === "iva-tenant-grant" &&
      principal.attributes.tenant_grant === "verified" &&
      typeof principal.attributes.tenant_id === "string"
    ) {
      const record = registry.get(principal.attributes.tenant_id);
      if (record === null || record.status !== "active") {
        throw new TenantResolutionError("No active tenant for service grant");
      }
      const base = tenantContextForRecord(record, join(root, "tenants"));
      return Object.freeze({ ...base, role: "service" as const });
    }
    return resolveTenantContext(registry, principal, join(root, "tenants"));
  } finally {
    registry.close();
  }
}

/** Bind one operation to the immutable tenant selected by Eve authentication. */
export function withTenantStoreFromSession<T>(
  session: TenantSessionContext,
  operation: (store: TenantStore) => T,
): T {
  let store: TenantStore | undefined;
  const close = () => {
    store?.close();
  };
  try {
    const context = tenantContextFromSession(session);
    store = new TenantStore(context);
    const result = operation(store);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      return Promise.resolve(result).finally(close) as T;
    }
    close();
    return result;
  } catch (error) {
    close();
    throw error;
  }
}
