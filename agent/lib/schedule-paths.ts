// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
}

export function resolvePaths(): SchedulePaths {
  const root = process.cwd();
  const resolvedDataDir = dataDir();
  return {
    root,
    dataDir: resolvedDataDir,
    statusPath: join(resolvedDataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
  };
}

export type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

// The dispatcher enumerates active tenants and gives each one its own runtime lock/cursor.
export function memoryRollupJob(period: MemoryPeriod) {
  const { root, statusPath } = resolvePaths();
  return {
    name: `memory-${period}`,
    argv: ["scripts/memory/tenants.ts", period],
    root,
    nodeBin: process.execPath,
    statusPath,
  };
}
