import { withTenantStoreFromSession } from "./tenant-session.ts";
import type { TenantSessionContext } from "./tenant-session.ts";
import { appendDaily } from "./vault-daily.ts";

export function persistCompletedAssistantTranscript(
  event: { readonly finishReason?: string; readonly message?: string | null },
  ctx: TenantSessionContext,
): void {
  if (event.finishReason === "tool-calls") return;
  const text = (event.message ?? "").trim();
  if (!text) return;
  withTenantStoreFromSession(ctx, (tenant) =>
    appendDaily(tenant.context.vaultRoot, "[iva]", text),
  );
}
