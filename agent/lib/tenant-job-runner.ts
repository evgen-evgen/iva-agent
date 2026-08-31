import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TenantContext, TenantRecord } from "./tenant-context.ts";
import { tenantContextForRecord } from "./tenant-context.ts";
import type { TenantRegistry } from "./tenant-registry.ts";
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomicSync,
} from "./fs-atomic.ts";

const SAFE_JOB_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type TenantJobCursor = {
  readonly tenantId: string;
  readonly job: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
};

export type TenantJobResult = {
  readonly tenantId: string;
  readonly status: "succeeded" | "failed" | "locked";
  readonly error?: unknown;
};

export type RunActiveTenantJobsOptions = {
  readonly registry: Pick<TenantRegistry, "listActive">;
  readonly tenantsRoot: string;
  readonly jobName: string;
  readonly lockName?: string;
  readonly concurrency?: number;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly now?: () => Date;
  readonly run: (context: TenantContext, record: TenantRecord) => Promise<void>;
};

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n]+/gu, " ").slice(0, 1000);
}

function writeCursor(path: string, cursor: TenantJobCursor): void {
  writeFileAtomicSync(path, `${JSON.stringify(cursor, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Runs one isolated job per active registry tenant. The registry selects tenants;
 * neither prompt content nor caller-provided filesystem paths can select a vault.
 */
export async function runActiveTenantJobs({
  registry,
  tenantsRoot,
  jobName,
  lockName = jobName,
  concurrency = 2,
  lockTimeoutMs = 0,
  lockStaleMs = 4 * 60 * 60 * 1000,
  now = () => new Date(),
  run,
}: RunActiveTenantJobsOptions): Promise<TenantJobResult[]> {
  if (!SAFE_JOB_NAME.test(jobName)) throw new Error("Invalid tenant job name");
  if (!SAFE_JOB_NAME.test(lockName))
    throw new Error("Invalid tenant lock name");
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    throw new Error("Tenant job concurrency must be an integer from 1 to 32");
  }

  const records = registry.listActive();
  const results = new Array<TenantJobResult>(records.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const record = records[index];
      if (record === undefined) return;
      const context = tenantContextForRecord(record, tenantsRoot);
      const jobsRoot = join(context.dataRoot, "runtime", "jobs");
      mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
      const cursorPath = join(jobsRoot, `${jobName}.json`);
      const lock = await acquireFileLock(join(jobsRoot, `${lockName}.lock`), {
        timeoutMs: lockTimeoutMs,
        staleMs: lockStaleMs,
      });
      if (lock === null) {
        results[index] = { tenantId: context.tenantId, status: "locked" };
        continue;
      }

      const startedAt = now().toISOString();
      try {
        writeCursor(cursorPath, {
          tenantId: context.tenantId,
          job: jobName,
          status: "running",
          startedAt,
        });
        await run(context, record);
        writeCursor(cursorPath, {
          tenantId: context.tenantId,
          job: jobName,
          status: "succeeded",
          startedAt,
          finishedAt: now().toISOString(),
        });
        results[index] = { tenantId: context.tenantId, status: "succeeded" };
      } catch (error) {
        writeCursor(cursorPath, {
          tenantId: context.tenantId,
          job: jobName,
          status: "failed",
          startedAt,
          finishedAt: now().toISOString(),
          error: errorText(error),
        });
        results[index] = {
          tenantId: context.tenantId,
          status: "failed",
          error,
        };
      } finally {
        releaseFileLock(lock);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  return results;
}
