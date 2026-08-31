import { readFileSync } from "node:fs";
import { CORE_CAP } from "./core-cap.ts";
import { clampCore } from "./core-clamp.ts";
import { resolveTenantPath } from "./tenant-path.ts";
import type { TenantContext } from "./tenant-context.ts";

const PERSONA_CAP = 800;
const NEUTRAL_PERSONA =
  "Use a neutral, respectful, and concise communication style until this user customizes it.";

function optionalFile(context: TenantContext, relativePath: string): string {
  try {
    return readFileSync(
      resolveTenantPath(context.vaultRoot, relativePath),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

export function tenantCoreMarkdown(context: TenantContext): string {
  let core = optionalFile(context, "CORE.md");
  if (!core) return "";
  if (core.length > CORE_CAP) core = clampCore(core);
  return `## CORE — кто пользователь и что в работе\n${core}`;
}

export function tenantPersonaMarkdown(context: TenantContext): string {
  let persona = optionalFile(context, "PERSONA.md") || NEUTRAL_PERSONA;
  if (persona.length > PERSONA_CAP) {
    persona = `${persona.slice(0, PERSONA_CAP)}\n…(PERSONA усечена)`;
  }
  return `## PERSONA — стиль общения\n${persona}`;
}
