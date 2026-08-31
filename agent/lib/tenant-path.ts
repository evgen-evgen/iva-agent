import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep, win32 } from "node:path";

export class TenantPathError extends Error {
  readonly code = "ETENANT_PATH";

  constructor() {
    super("Path is outside the tenant storage boundary");
    this.name = "TenantPathError";
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function relativeSegments(relativePath: string): string[] {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath)
  ) {
    throw new TenantPathError();
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TenantPathError();
  }
  return segments;
}

/**
 * Resolve a tenant-relative path and reject every existing symlink in its chain.
 * Missing final components are allowed for creation; their nearest existing parent
 * is still physically proven to be inside the tenant root.
 */
export function resolveTenantPath(root: string, relativePath: string): string {
  const requestedRoot = resolve(root);
  let physicalRoot: string;
  try {
    const rootStat = lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TenantPathError();
    }
    physicalRoot = realpathSync(requestedRoot);
  } catch (error) {
    if (error instanceof TenantPathError) throw error;
    throw new TenantPathError();
  }
  if (physicalRoot !== requestedRoot) throw new TenantPathError();

  const segments = relativeSegments(relativePath);
  let current = physicalRoot;
  let reachedMissingComponent = false;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!contained(physicalRoot, current)) throw new TenantPathError();
    if (reachedMissingComponent) continue;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new TenantPathError();
      const physical = realpathSync(current);
      if (!contained(physicalRoot, physical)) throw new TenantPathError();
      current = physical;
    } catch (error) {
      if (error instanceof TenantPathError) throw error;
      if (!isMissing(error)) throw new TenantPathError();
      reachedMissingComponent = true;
    }
  }
  return current;
}
