import { setTimeout } from "node:timers/promises";
import { PlaudRateLimitError, type PlaudCall } from "./plaud-import.ts";

/** Keep archive scans below Plaud's burst limit and back off only on explicit 429s. */
export function limitPlaudCalls(
  call: PlaudCall,
  {
    now = Date.now,
    wait = (ms: number) => setTimeout(ms),
    intervalMs = 2_000,
    retryDelaysMs = [15_000, 30_000, 60_000],
  }: {
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
  } = {},
): PlaudCall {
  let nextAt = 0;
  let queue = Promise.resolve();
  return (name, args) => {
    const result = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const delay = nextAt - now();
        if (delay > 0) await wait(delay);
        nextAt = now() + intervalMs;
        try {
          return await call(name, args);
        } catch (error) {
          if (
            !(error instanceof PlaudRateLimitError) ||
            attempt >= retryDelaysMs.length
          )
            throw error;
          await wait(retryDelaysMs[attempt]);
        }
      }
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
