import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "eve/client";
import {
  MEMORY_EVAL_DATE_FILE,
  MEMORY_EVAL_MODE_ENV,
} from "../../agent/lib/memory-date.ts";
import { resolveModelProvider } from "../../agent/lib/model-provider.ts";

type Mode = "stock" | "ceo-schema";
type RequestedMode = Mode | "both";

type CliOptions = {
  mode: RequestedMode;
  output?: string;
  prepareOnly: boolean;
  skipQuestions: boolean;
};

type Scenario = {
  id: string;
  version: string;
  timezone: string;
  period: { start: string; end: string };
  source_entries: Array<{ file: string }>;
};

type Question = {
  id: string;
  checkpoint: string;
  category: string;
  prompt: string;
  critical: boolean;
  expected: {
    required_claims: string[];
    forbidden_claims?: string[];
    source_refs: string[];
  };
};

type QuestionFile = { questions: Question[] };

type Answer = {
  id: string;
  checkpoint: string;
  category: string;
  critical: boolean;
  prompt: string;
  reply: string | null;
  status: string;
  transport_status?: string;
  error?: string;
};

export type ArtifactIssue = {
  date: string;
  code: string;
  path: string;
  message: string;
};

type ServerHandle = {
  child: ChildProcess;
  host: string;
  bearer: string;
  logPath: string;
};

type BenchmarkModelMetadata = {
  provider: string;
  model: string;
  vision_model: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "evals", "ceo-memory", "v1");
const EVE_BIN = join(ROOT, "node_modules", "eve", "bin", "eve.js");
const TURN_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 90_000;
const CODEX_AUTH_DATA_DIR_ENV = "IVA_CODEX_AUTH_DATA_DIR";

export function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "stock",
    prepareOnly: false,
    skipQuestions: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--mode") {
      const mode = args[++index];
      if (!mode || !["stock", "ceo-schema", "both"].includes(mode)) {
        throw new Error("--mode must be stock, ceo-schema, or both");
      }
      options.mode = mode as RequestedMode;
    } else if (arg === "--output") {
      const output = args[++index];
      if (!output) throw new Error("--output requires a path");
      options.output = output;
    } else if (arg === "--prepare-only") {
      options.prepareOnly = true;
    } else if (arg === "--skip-questions") {
      options.skipQuestions = true;
    } else if (arg === "--help" || arg === "-h") {
      throw Object.assign(new Error("help"), { code: "HELP" });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    "Usage: npm run eval:ceo-memory -- [options]",
    "",
    "Options:",
    "  --mode stock|ceo-schema|both  Run one architecture (default: stock)",
    "  --output PATH                 New output directory (default: data/ceo-memory-benchmarks/<timestamp>)",
    "  --prepare-only                Create isolated vaults without calling a model",
    "  --skip-questions              Process the week but do not ask recall questions",
    "  -h, --help                    Show this help",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value)
        ? deepMerge(existing, value)
        : structuredClone(value);
  }
  return merged;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function outputPath(requested?: string): string {
  if (!requested)
    return join(ROOT, "data", "ceo-memory-benchmarks", timestamp());
  return isAbsolute(requested) ? requested : resolve(ROOT, requested);
}

export function resolveCodexAuthDataDir(
  env: NodeJS.ProcessEnv,
  root = ROOT,
): string {
  const configured =
    env[CODEX_AUTH_DATA_DIR_ENV]?.trim() ||
    env.ASSISTANT_DATA_DIR?.trim() ||
    "data";
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

export function benchmarkModelMetadata(
  env: NodeJS.ProcessEnv,
): BenchmarkModelMetadata {
  const selected = resolveModelProvider(env);
  return {
    provider: selected.name,
    model: selected.model,
    vision_model: selected.visionModel,
  };
}

async function createNewDirectory(path: string): Promise<void> {
  if (existsSync(path)) {
    const kind = statSync(path).isDirectory() ? "directory" : "file";
    throw new Error(`Output ${kind} already exists: ${path}`);
  }
  await mkdir(path, { recursive: true });
}

async function prepareMode(root: string, mode: Mode): Promise<string> {
  const modeDir = join(root, mode);
  const vault = join(modeDir, "vault");
  await mkdir(modeDir, { recursive: true });
  await cp(join(ROOT, "vault-template"), vault, { recursive: true });
  await mkdir(join(vault, "daily"), { recursive: true });
  await mkdir(join(modeDir, "data"), { recursive: true });
  await mkdir(join(modeDir, "snapshots"), { recursive: true });
  await mkdir(join(modeDir, "answers"), { recursive: true });

  if (mode === "ceo-schema") {
    const schema = JSON.parse(
      await readFile(join(vault, "schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const overlay = JSON.parse(
      await readFile(join(FIXTURE, "schema-ceo-extension.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      join(vault, "schema.json"),
      `${JSON.stringify(deepMerge(schema, overlay), null, 2)}\n`,
      "utf8",
    );
  }
  return modeDir;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function isolatedEnv({
  vault,
  data,
  port,
  bearer,
  timezone,
}: {
  vault: string;
  data: string;
  port: number;
  bearer: string;
  timezone: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASSISTANT_VAULT_DIR: vault,
    ASSISTANT_DATA_DIR: data,
    ASSISTANT_TIMEZONE: timezone,
    ASSISTANT_HOST: `http://127.0.0.1:${port}`,
    ASSISTANT_BEARER: bearer,
    IVA_PORT: String(port),
    PORT: String(port),
    IVA_HEALTH_PROBE: "1",
    IVA_DISABLE_TRANSCRIPT: "1",
    [MEMORY_EVAL_MODE_ENV]: "1",
  };

  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_DIGEST_CHAT_ID",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_WEBHOOK_SECRET_TOKEN",
  ]) {
    delete env[key];
  }

  const provider = env.MODEL_PROVIDER ?? "ollama";
  if (provider === "openrouter" && !env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(
      "OPENROUTER_API_KEY is required when MODEL_PROVIDER=openrouter. " +
        "Create a key at https://openrouter.ai/keys and add it to .env.",
    );
  }

  if (provider === "codex") {
    const authDataDir = resolveCodexAuthDataDir(process.env);
    const authFile = join(authDataDir, "codex-auth.json");
    if (!existsSync(authFile)) {
      throw new Error(
        `Codex auth was not found at ${authFile}. Run `iva login` in this checkout ` +
          `or set ${CODEX_AUTH_DATA_DIR_ENV}=/path/to/your/working-iva/data before the benchmark.`,
      );
    }
    env[CODEX_AUTH_DATA_DIR_ENV] = authDataDir;
  }
  return env;
}

async function waitForHealth(server: ServerHandle): Promise<void> {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Isolated Eve server exited with ${server.child.exitCode}; see ${server.logPath}`,
      );
    }
    try {
      const response = await fetch(`${server.host}/eve/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Startup races are expected until the deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Isolated Eve server did not become healthy; see ${server.logPath}`,
  );
}

async function startServer({
  vault,
  data,
  timezone,
  logPath,
}: {
  vault: string;
  data: string;
  timezone: string;
  logPath: string;
}): Promise<{ server: ServerHandle; env: NodeJS.ProcessEnv }> {
  const port = await freePort();
  const bearer = randomBytes(24).toString("hex");
  const env = isolatedEnv({ vault, data, port, bearer, timezone });
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(
    process.execPath,
    [EVE_BIN, "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const server = {
    child,
    host: `http://127.0.0.1:${port}`,
    bearer,
    logPath,
  };
  await waitForHealth(server);
  return { server, env };
}

async function stopServer(server: ServerHandle | null): Promise<void> {
  if (!server || server.child.exitCode !== null || !server.child.pid) return;
  const exited = new Promise<void>((resolveExit) =>
    server.child.once("exit", () => resolveExit()),
  );
  try {
    process.kill(-server.child.pid, "SIGTERM");
  } catch {
    return;
  }
  const timeout = new Promise<"timeout">((resolveTimeout) =>
    setTimeout(resolveTimeout, 10_000, "timeout"),
  );
  if ((await Promise.race([exited, timeout])) === "timeout") {
    try {
      process.kill(-server.child.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
    await exited;
  }
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
): Promise<void> {
  const log = createWriteStream(logPath, { flags: "a" });
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.once("error", reject);
    child.once("exit", (code) => {
      log.end();
      if (code === 0) resolveRun();
      else
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function sendQuestion(
  server: ServerHandle,
  prompt: string,
): Promise<{
  status: string;
  reply: string | null;
  transport_status?: string;
  error?: string;
}> {
  const client = new Client({
    host: server.host,
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Eve expects an async bearer callback.
      bearer: async () => server.bearer,
    },
  });
  const session = client.session();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      session.send(prompt).then((turn) => turn.result()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          reject,
          TURN_TIMEOUT_MS,
          new Error(`Question timed out after ${TURN_TIMEOUT_MS / 1000}s`),
        );
      }),
    ]);
    return normalizeQuestionResult(result);
  } catch (error) {
    return {
      status: "error",
      reply: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeQuestionResult(result: {
  status: string;
  message?: string | null;
}): {
  status: string;
  reply: string | null;
  transport_status?: string;
  error?: string;
} {
  const reply = result.message?.trim() || null;
  if (result.status === "failed") {
    return { status: "failed", reply, error: "turn failed" };
  }
  if (reply) {
    return {
      status: "completed",
      reply,
      ...(result.status === "completed"
        ? {}
        : { transport_status: result.status }),
    };
  }
  return { status: result.status, reply: null };
}

function dates(scenario: Scenario): string[] {
  return [
    ...new Set(
      scenario.source_entries.map((entry) => {
        const match = /(\d{4}-\d{2}-\d{2})\.md$/.exec(entry.file);
        if (!match) throw new Error(`Cannot derive date from ${entry.file}`);
        return match[1];
      }),
    ),
  ].sort();
}

function issue(
  date: string,
  code: string,
  path: string,
  message: string,
): ArtifactIssue {
  return { date, code, path, message };
}

export async function validateDailyArtifacts(
  vault: string,
  date: string,
): Promise<ArtifactIssue[]> {
  const issues: ArtifactIssue[] = [];
  const rawRelative = `daily/${date}.md`;
  const summaryRelative = `summaries/daily/${date}.md`;
  const rawPath = join(vault, rawRelative);
  const summaryPath = join(vault, summaryRelative);

  if (!existsSync(rawPath)) {
    issues.push(
      issue(date, "missing-daily", rawRelative, "Raw daily file is missing."),
    );
  } else {
    const raw = await readFile(rawPath, "utf8");
    const marker = new RegExp(
      `<!-- processed: ${date}T\\d{2}:\\d{2} -->[\\s\\S]*summary: summaries/daily/${date}\\.md`,
    );
    if (!marker.test(raw)) {
      issues.push(
        issue(
          date,
          "missing-processing-marker",
          rawRelative,
          "Daily rollup did not append the required processed marker and summary reference.",
        ),
      );
    }
  }

  if (!existsSync(summaryPath)) {
    issues.push(
      issue(
        date,
        "missing-daily-summary",
        summaryRelative,
        "Daily summary is missing.",
      ),
    );
  } else {
    const summary = await readFile(summaryPath, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(summary)?.[1];
    if (!frontmatter) {
      issues.push(
        issue(
          date,
          "missing-summary-frontmatter",
          summaryRelative,
          "Daily summary does not start with YAML frontmatter.",
        ),
      );
    } else {
      const required = [
        ["type", /^type:\s*daily-summary\s*$/m],
        ["date", new RegExp(`^date:\\s*${date}\\s*$`, "m")],
        [
          "source",
          new RegExp(`^source:\\s*daily/${date}\\.md\\s*$`, "m"),
        ],
      ] as const;
      for (const [field, pattern] of required) {
        if (!pattern.test(frontmatter)) {
          issues.push(
            issue(
              date,
              `invalid-summary-${field}`,
              summaryRelative,
              `Daily summary frontmatter is missing the expected ${field}.`,
            ),
          );
        }
      }
    }
  }

  const graphRelative = ".graph/vault-graph.json";
  if (!existsSync(join(vault, graphRelative))) {
    issues.push(
      issue(
        date,
        "missing-vault-graph",
        graphRelative,
        "Mechanical autograph pass did not generate the vault graph.",
      ),
    );
  }

  const mocRelative = "MOC.md";
  const mocPath = join(vault, mocRelative);
  if (
    !existsSync(mocPath) ||
    !(await readFile(mocPath, "utf8")).includes("[[MOC/")
  ) {
    issues.push(
      issue(
        date,
        "stale-moc",
        mocRelative,
        "Mechanical autograph pass did not generate a card-linked MOC hub.",
      ),
    );
  }

  if (date >= "2026-09-10") {
    const deltaRelative = "cards/projects/delta.md";
    const deltaPath = join(vault, deltaRelative);
    if (!existsSync(deltaPath)) {
      issues.push(
        issue(
          date,
          "missing-delta-card",
          deltaRelative,
          "The benchmark project card is missing after the launch-date decision.",
        ),
      );
    } else {
      const delta = await readFile(deltaPath, "utf8");
      const historyIndex = delta.search(/^## History\s*$/m);
      if (historyIndex < 0) {
        issues.push(
          issue(
            date,
            "missing-delta-history",
            deltaRelative,
            "The superseded 18 September launch date was not preserved under History.",
          ),
        );
      } else {
        const current = delta.slice(0, historyIndex);
        const history = delta.slice(historyIndex);
        const currentDate = /(2026-09-25|25\s+сентября|September\s+25)/i;
        const oldDate = /(2026-09-18|18\s+сентября|September\s+18)/i;
        if (!currentDate.test(current)) {
          issues.push(
            issue(
              date,
              "missing-current-launch-date",
              deltaRelative,
              "The current section does not contain the 25 September launch date.",
            ),
          );
        }
        if (!oldDate.test(history)) {
          issues.push(
            issue(
              date,
              "missing-superseded-launch-date",
              deltaRelative,
              "History does not contain the superseded 18 September launch date.",
            ),
          );
        }
      }
    }
  }

  return issues;
}

async function writeArtifactValidation(
  modeDir: string,
  checkedDates: string[],
  issues: ArtifactIssue[],
): Promise<void> {
  await writeFile(
    join(modeDir, "artifact-validation.json"),
    `${JSON.stringify(
      {
        status: issues.length === 0 ? "passed" : "failed",
        checked_dates: checkedDates,
        issue_count: issues.length,
        issues,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function processWeek(
  modeDir: string,
  scenario: Scenario,
): Promise<ArtifactIssue[]> {
  const vault = join(modeDir, "vault");
  const data = join(modeDir, "data");
  const serverLog = join(modeDir, "processing-server.log");
  const artifactIssues: ArtifactIssue[] = [];
  const checkedDates: string[] = [];
  let server: ServerHandle | null = null;
  try {
    const started = await startServer({
      vault,
      data,
      timezone: scenario.timezone,
      logPath: serverLog,
    });
    server = started.server;
    for (const date of dates(scenario)) {
      console.log(`[${modeDir.split("/").at(-1)}] processing ${date}`);
      await cp(
        join(FIXTURE, "sources", "daily", `${date}.md`),
        join(vault, "daily", `${date}.md`),
      );
      await writeFile(join(data, MEMORY_EVAL_DATE_FILE), `${date}\n`, "utf8");
      await runCommand(
        process.execPath,
        [
          join(ROOT, "scripts", "memory", "rollup.ts"),
          "daily",
          "--target-date",
          date,
        ],
        started.env,
        join(modeDir, `rollup-${date}.log`),
      );
      const dailyIssues = await validateDailyArtifacts(vault, date);
      artifactIssues.push(...dailyIssues);
      checkedDates.push(date);
      await writeArtifactValidation(modeDir, checkedDates, artifactIssues);
      if (dailyIssues.length > 0) {
        console.warn(
          `[${modeDir.split("/").at(-1)}] ${date}: ${dailyIssues.length} artifact contract issue(s)`,
        );
      }
      await cp(vault, join(modeDir, "snapshots", date), { recursive: true });
    }
  } finally {
    await stopServer(server);
  }
  return artifactIssues;
}

function checkpointDate(checkpoint: string, scenario: Scenario): string {
  return checkpoint === "final" ? scenario.period.end : checkpoint;
}

async function askQuestions(
  modeDir: string,
  scenario: Scenario,
  questions: Question[],
): Promise<Answer[]> {
  const grouped = new Map<string, Question[]>();
  for (const question of questions) {
    const date = checkpointDate(question.checkpoint, scenario);
    const values = grouped.get(date) ?? [];
    values.push(question);
    grouped.set(date, values);
  }

  const answers: Answer[] = [];
  for (const [date, checkpointQuestions] of grouped) {
    const vault = join(modeDir, "snapshots", date);
    const data = join(modeDir, "question-data", date);
    await mkdir(data, { recursive: true });
    await writeFile(join(data, MEMORY_EVAL_DATE_FILE), `${date}\n`, "utf8");
    let server: ServerHandle | null = null;
    try {
      const started = await startServer({
        vault,
        data,
        timezone: scenario.timezone,
        logPath: join(modeDir, "answers", `${date}-server.log`),
      });
      server = started.server;
      for (const question of checkpointQuestions) {
        console.log(
          `[${modeDir.split("/").at(-1)}] asking ${question.id} at ${date}`,
        );
        const result = await sendQuestion(server, question.prompt);
        answers.push({
          id: question.id,
          checkpoint: question.checkpoint,
          category: question.category,
          critical: question.critical,
          prompt: question.prompt,
          ...result,
        });
        await writeFile(
          join(modeDir, "answers", "answers.json"),
          `${JSON.stringify(answers, null, 2)}\n`,
          "utf8",
        );
      }
    } finally {
      await stopServer(server);
    }
  }
  return answers;
}

function reviewMarkdown(questions: Question[], answers: Answer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const lines = [
    "# CEO memory benchmark — manual review",
    "",
    "Use `v1/rubric.md`: mark 2 (correct), 1 (partial), or 0 (incorrect). Any forbidden claim on a critical question is a critical error.",
    "",
  ];
  for (const question of questions) {
    const answer = byId.get(question.id);
    lines.push(
      `## ${question.id} — ${question.category}${question.critical ? " — CRITICAL" : ""}`,
      "",
      `**Checkpoint:** ${question.checkpoint}`,
      "",
      `**Question:** ${question.prompt}`,
      "",
      "**Iva answer:**",
      "",
      answer?.reply ?? `ERROR: ${answer?.error ?? "no answer"}`,
      "",
      "**Required claims:**",
      "",
      ...question.expected.required_claims.map((claim) => `- ${claim}`),
      "",
      "**Forbidden claims:**",
      "",
      ...(question.expected.forbidden_claims?.map((claim) => `- ${claim}`) ?? [
        "- (none)",
      ]),
      "",
      `**Sources:** ${question.expected.source_refs.join(", ")}`,
      "",
      "**Manual score:** [ ] 2  [ ] 1  [ ] 0  [ ] critical error",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function runMode(
  root: string,
  mode: Mode,
  scenario: Scenario,
  questions: Question[],
  options: CliOptions,
): Promise<ArtifactIssue[]> {
  const modeDir = await prepareMode(root, mode);
  if (options.prepareOnly) return [];
  const artifactIssues = await processWeek(modeDir, scenario);
  if (options.skipQuestions) return artifactIssues;
  const answers = await askQuestions(modeDir, scenario, questions);
  await writeFile(
    join(modeDir, "review.md"),
    reviewMarkdown(questions, answers),
    "utf8",
  );
  return artifactIssues;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    if ((error as { code?: string }).code === "HELP") {
      console.log(usage());
      return;
    }
    throw error;
  }

  if (!existsSync(EVE_BIN) && !options.prepareOnly) {
    throw new Error(
      "Dependencies are missing. Run npm ci before the benchmark.",
    );
  }

  const scenario = JSON.parse(
    readFileSync(join(FIXTURE, "scenario.json"), "utf8"),
  ) as Scenario;
  const questions = (
    JSON.parse(
      readFileSync(join(FIXTURE, "questions.json"), "utf8"),
    ) as QuestionFile
  ).questions;
  const root = outputPath(options.output);
  await createNewDirectory(root);
  const model = benchmarkModelMetadata(process.env);

  const modes: Mode[] =
    options.mode === "both" ? ["stock", "ceo-schema"] : [options.mode];
  const runRecord: Record<string, unknown> = {
    scenario: scenario.id,
    version: scenario.version,
    created_at: new Date().toISOString(),
    modes,
    ...model,
    prepare_only: options.prepareOnly,
    questions: options.skipQuestions ? "skipped" : "enabled",
  };
  await writeFile(
    join(root, "run.json"),
    `${JSON.stringify(runRecord, null, 2)}\n`,
    "utf8",
  );

  if (!options.prepareOnly) {
    console.log(`Provider: ${model.provider}; model: ${model.model}`);
  }

  const validation: Record<string, { status: string; issue_count: number }> =
    {};
  let issueCount = 0;
  for (const mode of modes) {
    const issues = await runMode(root, mode, scenario, questions, options);
    issueCount += issues.length;
    validation[mode] = {
      status: issues.length === 0 ? "passed" : "failed",
      issue_count: issues.length,
    };
  }
  runRecord.completed_at = new Date().toISOString();
  runRecord.status = options.prepareOnly
    ? "prepared"
    : issueCount === 0
      ? "completed"
      : "completed_with_artifact_failures";
  runRecord.artifact_validation = validation;
  await writeFile(
    join(root, "run.json"),
    `${JSON.stringify(runRecord, null, 2)}\n`,
    "utf8",
  );
  console.log(`CEO memory benchmark output: ${root}`);
  if (issueCount > 0) {
    console.error(
      `Artifact contract failed with ${issueCount} issue(s). See artifact-validation.json; answers and snapshots were preserved.`,
    );
    process.exitCode = 2;
  }
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
