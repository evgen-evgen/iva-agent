import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaPath(vault: string): string {
  const candidates = [
    join(vault, "schema.json"),
    join(vault, ".claude", "skills", "autograph", "schema.json"),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** Return the schema-owned commitment folder, or null when this vault is stock. */
export function commitmentDirectory(vault: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(schemaPath(vault), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.node_types)) return null;
    if (!isRecord(parsed.node_types.commitment)) return null;
    if (isRecord(parsed.card_type_dirs)) {
      const configured = parsed.card_type_dirs.commitment;
      if (
        typeof configured === "string" &&
        /^[\p{L}\p{N}._-]+$/u.test(configured.trim()) &&
        ![".", ".."].includes(configured.trim())
      ) {
        return configured.trim();
      }
    }
    if (isRecord(parsed.path_type_hints)) {
      for (const [prefix, type] of Object.entries(parsed.path_type_hints)) {
        const match = /^cards\/([^/]+)\/$/.exec(prefix);
        if (type === "commitment" && match) return match[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function commitmentsEnabled(vault: string): boolean {
  return commitmentDirectory(vault) !== null;
}
