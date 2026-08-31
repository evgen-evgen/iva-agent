import {
  ownerTelegramUsers,
  validateTelegramOwnerConfiguration,
} from "./telegram-allowlist.ts";
import type { TenantRecord } from "./tenant-context.ts";
import { TenantRegistry } from "./tenant-registry.ts";

type TelegramAccessEnvironment = {
  /** Deprecated and intentionally ignored: private-user admission is automatic. */
  readonly TELEGRAM_ALLOWED_USER_IDS?: string;
  readonly TELEGRAM_OWNER_USER_IDS?: string;
};

const AUTHENTICATOR = "telegram-bot";
const ISSUER = "telegram";
const PRINCIPAL_PREFIX = "telegram:";

function externalPrincipal(userId: string): string {
  return `${PRINCIPAL_PREFIX}${userId}`;
}

function telegramUserId(principal: string): string | null {
  return principal.startsWith(PRINCIPAL_PREFIX)
    ? principal.slice(PRINCIPAL_PREFIX.length)
    : null;
}

/**
 * Recalculate owner roles without disabling automatically registered users.
 */
export function reconcileTelegramTenants(
  registry: TenantRegistry,
  env: TelegramAccessEnvironment = process.env,
): void {
  validateTelegramOwnerConfiguration(env);
  const owners = ownerTelegramUsers(env);
  const existing = registry.listByAuthenticator(AUTHENTICATOR, ISSUER);
  const seen = new Set<string>();

  for (const record of existing) {
    const userId = telegramUserId(record.identity.externalPrincipal);
    if (userId === null) continue;
    seen.add(userId);
    registry.update(record.tenantId, {
      role: owners.has(userId) ? "owner" : "user",
      telegramDestination: record.telegramDestination ?? userId,
    });
  }
  // Owners must exist before the first control command. The deprecated allowlist
  // is migration input only: older installations may seed their existing users,
  // but it never gates admission and is never required in new configuration.
  const configured = new Set([
    ...owners,
    ...(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/u)
      .map((id) => id.trim())
      .filter((id) => /^[1-9][0-9]*$/u.test(id)),
  ]);
  for (const userId of configured) {
    if (seen.has(userId)) continue;
    registry.create(
      {
        authenticator: AUTHENTICATOR,
        issuer: ISSUER,
        externalPrincipal: externalPrincipal(userId),
      },
      {
        role: owners.has(userId) ? "owner" : "user",
        status: "active",
        telegramDestination: userId,
      },
    );
  }
}

export function ensureTelegramTenant(
  registry: TenantRegistry,
  userId: string,
  env: TelegramAccessEnvironment = process.env,
): TenantRecord {
  validateTelegramOwnerConfiguration(env);
  if (!/^[1-9][0-9]*$/u.test(userId)) {
    throw new Error("Invalid Telegram user ID");
  }
  const identity = {
    authenticator: AUTHENTICATOR,
    issuer: ISSUER,
    externalPrincipal: externalPrincipal(userId),
  } as const;
  const role = ownerTelegramUsers(env).has(userId) ? "owner" : "user";
  const existing = registry.findByIdentity(identity);
  if (existing === null) {
    return registry.create(identity, {
      role,
      status: "active",
      telegramDestination: userId,
    });
  }
  return registry.update(existing.tenantId, {
    role,
    status: "active",
    telegramDestination: existing.telegramDestination ?? userId,
  });
}
