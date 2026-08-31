import { resolveTenantPath, TenantPathError } from "./tenant-path.ts";

/** Model-facing memory paths are relative and may not address hidden metadata. */
export function resolveTenantMemoryPath(
  vaultRoot: string,
  relativePath: string,
): string {
  const normalized = relativePath.trim();
  const segments = normalized.replaceAll("\\", "/").split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new TenantPathError();
  }
  return resolveTenantPath(vaultRoot, normalized);
}

export function assertSafeTenantGlob(pattern: string): void {
  const normalized = pattern.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === ".." || segment === "." || segment.startsWith("."),
      )
  ) {
    throw new TenantPathError();
  }
}
