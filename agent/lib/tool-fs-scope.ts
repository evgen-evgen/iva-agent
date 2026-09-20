import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve, sep } from "node:path";

export const TOOL_FS_ROOT_ENV = "IVA_TOOL_FS_ROOT";
export const TOOL_FS_READ_ROOTS_ENV = "IVA_TOOL_FS_READ_ROOTS";
export const TOOL_FS_READ_ONLY_ENV = "IVA_TOOL_FS_READ_ONLY";

export class ToolFsScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFsScopeError";
  }
}

export function toolFsRoot(): string | null {
  const configured = process.env[TOOL_FS_ROOT_ENV]?.trim();
  return configured ? resolve(configured) : null;
}

export function toolFsReadOnly(): boolean {
  return toolFsRoot() !== null && process.env[TOOL_FS_READ_ONLY_ENV] === "1";
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpathSync(current);
}

function readRoots(primary: string): string[] {
  const configured = process.env[TOOL_FS_READ_ROOTS_ENV] ?? "";
  return [
    primary,
    ...configured
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolve(item)),
  ];
}

/**
 * Resolve a model-supplied path inside the optional host-tool scope.
 *
 * With no scope configured this returns null so every tool can preserve its historical
 * production path semantics. With a scope, relative paths are rooted there and absolute
 * paths must stay inside an allowed root both lexically and after resolving symlinks.
 */
export function resolveScopedToolPath(
  input: string,
  access: "read" | "write",
): string | null {
  const primary = toolFsRoot();
  if (!primary) return null;

  const candidate = isAbsolute(input)
    ? resolve(input)
    : resolve(primary, input);
  const allowed = access === "read" ? readRoots(primary) : [primary];
  const lexicalRoot = allowed.find((root) => contains(root, candidate));
  if (!lexicalRoot) {
    throw new ToolFsScopeError(
      `Path "${input}" is outside the isolated file scope (${primary}).`,
    );
  }

  const physicalRoot = existingAncestor(lexicalRoot);
  const physicalCandidate = existingAncestor(candidate);
  if (!contains(physicalRoot, physicalCandidate)) {
    throw new ToolFsScopeError(
      `Path "${input}" escapes the isolated file scope through a symlink.`,
    );
  }
  return candidate;
}
