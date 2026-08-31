import type { TenantSessionContext } from "./tenant-session.ts";
import { tenantContextFromSession } from "./tenant-session.ts";

export type TenantCapabilityProfile = "telegram-user" | "telegram-owner";

export const TENANT_SAFE_TOOLS = new Set([
  "glob",
  "grep",
  "memory_search",
  "read_file",
  "tasks",
  "web_fetch",
  "web_search",
  "write_card",
  "write_file",
] as const);

export const OWNER_ONLY_TOOLS = new Set(["bash", "connection_search"] as const);

export function tenantCapabilityProfile(
  session: TenantSessionContext,
): TenantCapabilityProfile {
  return tenantContextFromSession(session).role === "owner"
    ? "telegram-owner"
    : "telegram-user";
}

export function toolAllowedForProfile(
  profile: TenantCapabilityProfile,
  toolName: string,
): boolean {
  if (TENANT_SAFE_TOOLS.has(toolName as never)) return true;
  return (
    profile === "telegram-owner" && OWNER_ONLY_TOOLS.has(toolName as never)
  );
}

export function ownerCapabilitiesAllowed(
  session: TenantSessionContext,
): boolean {
  return tenantCapabilityProfile(session) === "telegram-owner";
}

export class OwnerCapabilityError extends Error {
  readonly code = "EOWNER_CAPABILITY_REQUIRED";

  constructor() {
    super("This capability is restricted to the installation owner");
    this.name = "OwnerCapabilityError";
  }
}

export function assertOwnerCapabilities(session: TenantSessionContext): void {
  if (!ownerCapabilitiesAllowed(session)) throw new OwnerCapabilityError();
}
