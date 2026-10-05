import { join } from "node:path";
import { defineSchedule } from "eve/schedules";
import { readSettings } from "../lib/settings.js";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: "5-59/10 * * * *",
  run({ waitUntil }) {
    if (
      (readSettings().mailSync as { enabled?: boolean } | undefined)
        ?.enabled !== true
    )
      return;
    const { root, dataDir } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "mail-sync",
        argv: ["scripts/mail-sync.ts", "--scheduled"],
        root,
        nodeBin: process.execPath,
        statusPath: join(dataDir, "mail-sync-status.json"),
        guardMs: 60_000,
        timeoutMs: 9 * 60_000,
      }),
    );
  },
});
