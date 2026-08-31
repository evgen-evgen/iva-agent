import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { resolveTenantContext, type TenantContext } from "./tenant-context.ts";
import type { TelegramInboundMessage } from "./telegram-inbound.ts";
import { isPrivateTelegramActor } from "./telegram-private-chat.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import { ensureTelegramTenant } from "./telegram-tenant-provisioning.ts";

export function resolveTelegramTenant(
  message: TelegramInboundMessage,
): TenantContext {
  const root = dataDir();
  const registry = new TenantRegistry(join(root, "tenants.sqlite"));
  try {
    const sender = message.from;
    if (
      sender === undefined ||
      sender.isBot === true ||
      !isPrivateTelegramActor(message.chat, sender?.id)
    ) {
      throw new Error("Telegram tenants require an authenticated private user");
    }
    ensureTelegramTenant(registry, String(sender.id));
    return resolveTenantContext(
      registry,
      message.from === undefined
        ? null
        : {
            authenticator: "telegram-bot",
            issuer: "telegram",
            principalId: `telegram:${message.from.id}`,
            principalType: message.from.isBot ? "service" : "user",
          },
      join(root, "tenants"),
    );
  } finally {
    registry.close();
  }
}

export function resolveTelegramTenantForUserId(userId: string): TenantContext {
  return resolveTelegramTenant({
    attachments: [],
    chat: { id: userId, type: "private" },
    from: { id: userId, isBot: false },
    messageId: "tenant-resolution",
    raw: {},
    text: "",
    caption: "",
  });
}
