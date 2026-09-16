import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { commitmentsEnabled } from "#lib/commitment-config.ts";
import { requireAppliedCommitmentPlan } from "#lib/commitment-plan.ts";

export interface FinalizerCommandResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export type FinalizerCommandRunner = (
  command: string,
  args: string[],
) => FinalizerCommandResult;

interface MemoryCommandOptions {
  vault: string;
  run?: FinalizerCommandRunner;
}

interface FinalizeDailyMemoryOptions extends MemoryCommandOptions {
  date: string;
  timezone: string;
  now?: Date;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTOGRAPH = join(ROOT, "scripts", "autograph");

function defaultRunner(
  command: string,
  args: string[],
): FinalizerCommandResult {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function outputTail(result: FinalizerCommandResult): string {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (!text) return result.error?.message ?? "";
  return text.split(/\r?\n/).slice(-8).join("\n");
}

function runAutograph(
  script: string,
  args: string[],
  run: FinalizerCommandRunner,
): void {
  const result = run("uv", ["run", join(AUTOGRAPH, script), ...args]);
  if (result.status === 0) return;
  const detail = outputTail(result);
  throw new Error(
    `autograph ${script} failed (exit=${result.status ?? "unknown"})${detail ? `:\n${detail}` : ""}`,
  );
}

function summaryFrontmatter(date: string): string {
  return [
    "---",
    "type: daily-summary",
    `date: ${date}`,
    `description: Daily memory summary for ${date}.`,
    "tags: [daily]",
    "status: active",
    "topics: []",
    `source: daily/${date}.md`,
    "---",
    "",
  ].join("\n");
}

function validateSummaryFrontmatter(text: string, date: string): void {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
  if (!frontmatter) {
    throw new Error("daily summary does not have closed YAML frontmatter");
  }
  const required: Array<[string, RegExp]> = [
    ["type", /^type:\s*daily-summary\s*$/m],
    ["date", new RegExp(`^date:\\s*${date}\\s*$`, "m")],
    ["description", /^description:\s*\S.+$/m],
    ["tags", /^tags:\s*\[.*\]\s*$/m],
    ["status", /^status:\s*active\s*$/m],
    ["topics", /^topics:\s*\[.*\]\s*$/m],
    ["source", new RegExp(`^source:\\s*daily/${date}\\.md\\s*$`, "m")],
  ];
  const missing = required
    .filter(([, pattern]) => !pattern.test(frontmatter))
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(
      `daily summary frontmatter is missing required fields: ${missing.join(", ")}`,
    );
  }
}

export function ensureDailySummaryFrontmatter(
  vault: string,
  date: string,
): string {
  const path = join(vault, "summaries", "daily", `${date}.md`);
  if (!existsSync(path)) {
    throw new Error(`daily summary is missing: ${path}`);
  }
  let text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) {
    text = summaryFrontmatter(date) + text;
    writeFileAtomicSync(path, text);
  }
  validateSummaryFrontmatter(text, date);
  return path;
}

function countExistingCardLinks(vault: string, summary: string): number {
  const targets = new Set<string>();
  for (const match of summary.matchAll(
    /\[\[(cards\/[^|\]#]+)(?:[|#][^\]]*)?\]\]/g,
  )) {
    const target = match[1].endsWith(".md") ? match[1] : `${match[1]}.md`;
    if (existsSync(join(vault, target))) targets.add(target);
  }
  return targets.size;
}

function markerTime(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

export function appendDailyProcessingMarker({
  vault,
  date,
  timezone,
  now = new Date(),
}: FinalizeDailyMemoryOptions): boolean {
  const path = join(vault, "daily", `${date}.md`);
  if (!existsSync(path)) throw new Error(`raw daily file is missing: ${path}`);
  const raw = readFileSync(path, "utf8");
  const existing = new RegExp(
    `<!-- processed: ${date}T\\d{2}:\\d{2} -->[\\s\\S]*?summary: summaries/daily/${date}\\.md`,
  );
  if (existing.test(raw)) return false;
  if (new RegExp(`<!-- processed: ${date}T`).test(raw)) {
    throw new Error(
      `raw daily file has an incomplete processing marker: ${path}`,
    );
  }

  const summaryPath = join(vault, "summaries", "daily", `${date}.md`);
  const cards = countExistingCardLinks(
    vault,
    readFileSync(summaryPath, "utf8"),
  );
  const separator = raw.endsWith("\n") ? "\n" : "\n\n";
  const stamp = `${date}T${markerTime(now, timezone)}`;
  const marker = [
    `<!-- processed: ${stamp} -->`,
    "",
    "---",
    "",
    `processed: ${stamp}`,
    `cards: ${cards}`,
    `summary: summaries/daily/${date}.md`,
    "---",
    "",
  ].join("\n");
  writeFileAtomicSync(path, raw + separator + marker);
  return true;
}

export function prepareDailyMemory({
  vault,
  run = defaultRunner,
}: MemoryCommandOptions): void {
  mkdirSync(join(vault, ".graph"), { recursive: true });
  runAutograph("supersede.py", [vault], run);
  const candidates = join(vault, ".graph", "supersede-candidates.json");
  if (!existsSync(candidates)) {
    throw new Error(`supersede scan did not create ${candidates}`);
  }
}

export function finalizeDailyMemory({
  vault,
  date,
  timezone,
  now = new Date(),
  run = defaultRunner,
}: FinalizeDailyMemoryOptions): void {
  if (commitmentsEnabled(vault)) requireAppliedCommitmentPlan(vault, date);
  const summaryPath = ensureDailySummaryFrontmatter(vault, date);
  const schemaPath = join(vault, "schema.json");

  runAutograph("cleanup.py", [vault, "--apply"], run);
  runAutograph("enforce.py", [vault, schemaPath, "--apply"], run);
  runAutograph("graph.py", ["fix", vault, schemaPath, "--apply"], run);
  runAutograph("engine.py", ["touch", summaryPath], run);
  runAutograph("moc.py", ["generate", vault, schemaPath], run);
  runAutograph("engine.py", ["decay", vault], run);
  runAutograph("graph.py", ["health", vault, schemaPath], run);

  const graph = join(vault, ".graph", "vault-graph.json");
  if (!existsSync(graph)) {
    throw new Error(`autograph health did not create ${graph}`);
  }
  appendDailyProcessingMarker({ vault, date, timezone, now });
}
