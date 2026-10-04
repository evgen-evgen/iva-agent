import { join } from "node:path";
import { defineSchedule } from "eve/schedules";
import { readSettings } from "../lib/settings.js";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    if (
      (readSettings().plaudSync as { enabled?: boolean } | undefined)
        ?.enabled !== true
    )
      return;
    const { root, dataDir } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "plaud-sync",
        argv: ["scripts/plaud-sync.ts", "--scheduled"],
        root,
        nodeBin: process.execPath,
        statusPath: join(dataDir, "plaud-sync-status.json"),
        guardMs: 60_000,
        timeoutMs: 9 * 60_000,
      }),
    );
  },
});
