import { rmSync } from "node:fs";

type ResettableSession = {
  reset(): Promise<{ status: string }>;
};

/**
 * Benchmark turns are intentionally one-shot. Retire their durable Eve owner so
 * a later dev server cannot redeliver an old workflow run.
 */
export async function retireMemoryEvalSession({
  enabled,
  session,
  cursorPath,
}: {
  enabled: boolean;
  session: ResettableSession;
  cursorPath?: string;
}): Promise<boolean> {
  if (!enabled) return false;

  const result = await session.reset();
  if (result.status !== "reset" && result.status !== "no_active_session") {
    throw new Error(`Unexpected Eve session reset status: ${result.status}`);
  }
  if (cursorPath) rmSync(cursorPath, { force: true });
  return true;
}
