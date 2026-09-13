import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { resolveTimeZone } from "./timezone.ts";

export const MEMORY_EVAL_MODE_ENV = "IVA_MEMORY_EVAL_MODE";
export const MEMORY_EVAL_DATE_FILE = "memory-eval-date";

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

/**
 * Date stamped onto cards. Production always uses the real local date. The benchmark
 * starts an explicitly marked isolated server and advances a small file before each
 * historical day; reading it per tool call lets one server process a whole fixture.
 */
export function memoryWriteDate(): string {
  if (process.env[MEMORY_EVAL_MODE_ENV] === "1") {
    const path = join(dataDir(), MEMORY_EVAL_DATE_FILE);
    const value = readFileSync(path, "utf8").trim();
    if (!isIsoCalendarDate(value)) {
      throw new Error(
        `${MEMORY_EVAL_DATE_FILE} must contain a valid YYYY-MM-DD date`,
      );
    }
    return value;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
