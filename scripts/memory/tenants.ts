import { spawn } from "node:child_process";
import { join } from "node:path";

type Job = "brain" | "daily" | "weekly" | "monthly" | "yearly" | "digest";
const JOBS = new Set<Job>([
  "brain",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "digest",
]);
const job = process.argv[2] as Job | undefined;
if (job === undefined || !JOBS.has(job)) {
  console.error("Usage: tenants.ts <brain|daily|weekly|monthly|yearly|digest>");
  process.exit(1);
}
const selectedJob: Job = job;

// Keep the systemd entrypoint loadable while an update is rebuilding the authored
// agent tree. The scheduled operation itself needs that tree, but merely loading and
// diagnosing the entrypoint must not resolve it eagerly.
const [{ dataDir }, { TenantRegistry }, { runActiveTenantJobs }] =
  await Promise.all([
    import("../../agent/lib/data-dir.ts"),
    import("../../agent/lib/tenant-registry.ts"),
    import("../../agent/lib/tenant-job-runner.ts"),
  ]);

const root = dataDir();
const registry = new TenantRegistry(join(root, "tenants.sqlite"));
const concurrency = Number(process.env.IVA_TENANT_JOB_CONCURRENCY ?? "2");

function childArgs(tenantId: string): string[] {
  if (selectedJob === "brain")
    return ["scripts/memory/brain.ts", "--tenant-id", tenantId];
  if (selectedJob === "digest")
    return ["scripts/daily-digest.ts", "--tenant-id", tenantId];
  return ["scripts/memory/rollup.ts", selectedJob, "--tenant-id", tenantId];
}

function runChild(tenantId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs(tenantId), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${selectedJob} exited ${code ?? signal ?? "unknown"}`),
        );
    });
  });
}

try {
  const results = await runActiveTenantJobs({
    registry,
    tenantsRoot: join(root, "tenants"),
    jobName:
      selectedJob === "brain" || selectedJob === "digest"
        ? selectedJob
        : `memory-${selectedJob}`,
    lockName: selectedJob === "digest" ? "digest" : "memory",
    concurrency,
    run: (context) => runChild(context.tenantId),
  });
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    console.error(
      `${selectedJob}: ${failed.length}/${results.length} tenant jobs failed`,
    );
    process.exitCode = 1;
  }
} finally {
  registry.close();
}
