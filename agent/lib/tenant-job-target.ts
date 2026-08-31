import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  tenantContextForRecord,
  TenantResolutionError,
  type TenantContext,
  type TenantRecord,
} from "./tenant-context.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import {
  createTenantServiceGrant,
  TENANT_GRANT_HEADER,
} from "./tenant-service-grant.ts";

const TENANT_ID = /^t_[0-9a-f]{32}$/u;

export type TenantJobTarget = {
  readonly context: TenantContext;
  readonly record: TenantRecord;
};

export function tenantIdArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf("--tenant-id");
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || !TENANT_ID.test(value)) return null;
  return value;
}

/** Resolve a CLI target back through the trusted registry, never directly to a path. */
export function resolveTenantJobTarget(
  argv: readonly string[] = process.argv.slice(2),
): TenantJobTarget {
  const tenantId = tenantIdArgument(argv);
  if (tenantId === null) {
    throw new TenantResolutionError("Scheduled job requires --tenant-id");
  }
  const root = dataDir();
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  try {
    const record = registry.get(tenantId);
    if (record === null || record.status !== "active") {
      throw new TenantResolutionError("Scheduled job tenant is not active");
    }
    return {
      context: Object.freeze({
        ...tenantContextForRecord(record, join(root, "tenants")),
        role: "service" as const,
      }),
      record,
    };
  } finally {
    registry.close();
  }
}

export function tenantGrantHeaders(
  target: TenantJobTarget,
  purpose: string,
  bearer = process.env.ASSISTANT_BEARER,
): Record<string, string> {
  if (!bearer) throw new Error("ASSISTANT_BEARER is required for tenant jobs");
  return {
    [TENANT_GRANT_HEADER]: createTenantServiceGrant(
      bearer,
      target.context.tenantId,
      purpose,
    ),
  };
}
