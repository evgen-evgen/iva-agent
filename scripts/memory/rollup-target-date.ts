import { isIsoCalendarDate } from "../../agent/lib/memory-date.ts";

type Period = "daily" | "weekly" | "monthly" | "yearly";

export function shiftIsoDate(iso: string, deltaDays: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

export function resolveDailyTargetDate(
  period: Period,
  args: readonly string[],
  localToday: string,
): string {
  const positions = args
    .map((arg, index) => (arg === "--target-date" ? index : -1))
    .filter((index) => index >= 0);

  if (positions.length === 0) {
    if (args.length > 0)
      throw new Error(`Unknown rollup arguments: ${args.join(" ")}`);
    return shiftIsoDate(localToday, -1);
  }
  if (positions.length > 1)
    throw new Error("--target-date may be provided only once");
  if (period !== "daily")
    throw new Error("--target-date is supported only for the daily rollup");

  const position = positions[0];
  const value = args[position + 1];
  if (!value || !isIsoCalendarDate(value)) {
    throw new Error("--target-date requires a valid YYYY-MM-DD date");
  }
  if (args.length !== 2 || position !== 0) {
    throw new Error(`Unknown rollup arguments: ${args.join(" ")}`);
  }
  if (value >= localToday) {
    throw new Error("--target-date must be a completed day before today");
  }
  return value;
}

export function resolveRollupPromptDate(
  period: Period,
  localToday: string,
  completedDay: string,
  evaluationMode: boolean,
): string {
  return evaluationMode && period === "daily" ? completedDay : localToday;
}
