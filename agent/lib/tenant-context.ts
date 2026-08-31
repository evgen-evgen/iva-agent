import { resolve } from "node:path";

export const TENANT_ROLES = ["owner", "user", "service"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const TENANT_STATUSES = ["active", "disabled"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export type TenantIdentity = {
  readonly authenticator: string;
  readonly issuer: string;
  readonly externalPrincipal: string;
};

export type TenantRecord = {
  readonly tenantId: string;
  readonly role: Exclude<TenantRole, "service">;
  readonly status: TenantStatus;
  readonly telegramDestination: string | null;
};

export type TenantContext = {
  readonly tenantId: string;
  readonly role: TenantRole;
  readonly dataRoot: string;
  readonly vaultRoot: string;
};

export type TenantPrincipal = {
  readonly authenticator?: unknown;
  readonly issuer?: unknown;
  readonly principalId?: unknown;
  readonly principalType?: unknown;
};

export interface TenantLookup {
  findByIdentity(identity: TenantIdentity): TenantRecord | null;
}

export class TenantResolutionError extends Error {
  readonly code = "ETENANT_RESOLUTION";

  constructor(message: string) {
    super(message);
    this.name = "TenantResolutionError";
  }
}

const COMPONENT_LIMIT = 255;
const PRINCIPAL_LIMIT = 1024;
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]*$/u;
const OPAQUE_TENANT_ID = /^t_[0-9a-f]{32}$/u;

function normalizedComponent(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TenantResolutionError(`Missing ${field}`);
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > COMPONENT_LIMIT ||
    !SAFE_COMPONENT.test(normalized)
  ) {
    throw new TenantResolutionError(`Unsupported ${field}`);
  }
  return normalized;
}

function normalizedPrincipal(value: unknown): string {
  if (typeof value !== "string") {
    throw new TenantResolutionError("Missing external principal");
  }
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    normalized.length === 0 ||
    normalized.length > PRINCIPAL_LIMIT ||
    hasControlCharacter
  ) {
    throw new TenantResolutionError("Unsupported external principal");
  }
  return normalized;
}

export function normalizeTenantIdentity(
  identity: TenantIdentity,
): TenantIdentity {
  return Object.freeze({
    authenticator: normalizedComponent(identity.authenticator, "authenticator"),
    issuer: normalizedComponent(identity.issuer, "issuer"),
    externalPrincipal: normalizedPrincipal(identity.externalPrincipal),
  });
}

export function tenantIdentityFromPrincipal(
  principal: TenantPrincipal | null | undefined,
): TenantIdentity {
  if (principal?.principalType !== "user") {
    throw new TenantResolutionError("Unsupported principal type");
  }
  return normalizeTenantIdentity({
    authenticator: principal.authenticator as string,
    issuer: principal.issuer as string,
    externalPrincipal: principal.principalId as string,
  });
}

export function tenantContextForRecord(
  record: TenantRecord,
  tenantsRoot: string,
): TenantContext {
  if (!OPAQUE_TENANT_ID.test(record.tenantId)) {
    throw new TenantResolutionError("Registry returned an invalid tenant ID");
  }
  const dataRoot = resolve(tenantsRoot, record.tenantId);
  return Object.freeze({
    tenantId: record.tenantId,
    role: record.role,
    dataRoot,
    vaultRoot: resolve(dataRoot, "vault"),
  });
}

export function resolveTenantContext(
  lookup: TenantLookup,
  principal: TenantPrincipal | null | undefined,
  tenantsRoot: string,
): TenantContext {
  const identity = tenantIdentityFromPrincipal(principal);
  const record = lookup.findByIdentity(identity);
  if (record === null || record.status !== "active") {
    throw new TenantResolutionError(
      "No active tenant for authenticated principal",
    );
  }
  return tenantContextForRecord(record, tenantsRoot);
}
