import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../agent/lib/fs-atomic.ts";

type JsonRecord = Record<string, unknown>;

const PROFILE = new URL("../vault-profiles/ceo/schema-extension.json", import.meta.url);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(root: JsonRecord, key: string): JsonRecord {
  const current = root[key];
  if (current === undefined) {
    const created: JsonRecord = {};
    root[key] = created;
    return created;
  }
  if (!isRecord(current)) throw new Error(`schema.json field ${key} must be an object`);
  return current;
}

function mergeType(target: JsonRecord, source: JsonRecord): boolean {
  let changed = false;
  if (typeof target.description !== "string" && typeof source.description === "string") {
    target.description = source.description;
    changed = true;
  }
  for (const key of ["required", "status"] as const) {
    const existing = target[key];
    const incoming = source[key];
    if (!Array.isArray(incoming) || !incoming.every((item) => typeof item === "string"))
      continue;
    if (existing === undefined) {
      target[key] = [...incoming];
      changed = true;
      continue;
    }
    if (!Array.isArray(existing) || !existing.every((item) => typeof item === "string"))
      throw new Error(`schema.json node type field ${key} must be a string array`);
    const merged = [...new Set([...existing, ...incoming])];
    if (merged.length !== existing.length) {
      target[key] = merged;
      changed = true;
    }
  }
  return changed;
}

/** Add the CEO profile to a vault without replacing its schema or existing cards. */
export function applyCeoProfile(vault: string): { changed: boolean; directories: string[] } {
  const extension = JSON.parse(readFileSync(PROFILE, "utf8")) as JsonRecord;
  const schemaPath = join(vault, "schema.json");
  if (!existsSync(schemaPath)) throw new Error(`schema.json is missing from ${vault}`);
  const parsed: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("schema.json must contain an object");
  let changed = false;

  const nodeTypes = recordAt(parsed, "node_types");
  const profileTypes = extension.node_types;
  if (!isRecord(profileTypes)) throw new Error("CEO profile node_types must be an object");
  for (const [name, definition] of Object.entries(profileTypes)) {
    if (!isRecord(definition)) throw new Error(`CEO profile node type ${name} is invalid`);
    const current = nodeTypes[name];
    if (current === undefined) {
      nodeTypes[name] = structuredClone(definition);
      changed = true;
    } else if (!isRecord(current)) {
      throw new Error(`schema.json node type ${name} must be an object`);
    } else {
      changed = mergeType(current, definition) || changed;
    }
  }

  for (const key of ["card_type_dirs", "domain_inference", "path_type_hints", "status_order"] as const) {
    const target = recordAt(parsed, key);
    const source = extension[key];
    if (!isRecord(source)) throw new Error(`CEO profile ${key} must be an object`);
    for (const [name, value] of Object.entries(source)) {
      if (target[name] === undefined) {
        target[name] = value;
        changed = true;
      }
    }
  }

  const typeDirs = parsed.card_type_dirs;
  if (!isRecord(typeDirs)) throw new Error("schema.json card_type_dirs must be an object");
  const directories: string[] = [];
  for (const type of ["commitment", "meeting"] as const) {
    const configured = typeDirs[type];
    const name = typeof configured === "string" ? configured : type === "meeting" ? "meetings" : "commitments";
    if (!/^[\p{L}\p{N}._-]+$/u.test(name) || name === "." || name === "..")
      throw new Error(`Unsafe ${type} card directory in schema.json`);
    const directory = join(vault, "cards", name);
    mkdirSync(directory, { recursive: true });
    directories.push(directory);
  }

  if (changed) writeFileAtomicSync(schemaPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { changed, directories };
}
