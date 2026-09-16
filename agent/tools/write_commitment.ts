import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  acquireLock,
  atomicWrite,
  extractH1,
  h2Sections,
  slugify,
} from "../lib/card-store.js";
import {
  parseFrontmatter,
  writeFrontmatter,
  type FmFields,
} from "../lib/frontmatter.js";
import { isIsoCalendarDate, memoryWriteDate } from "../lib/memory-date.ts";

// Commitments are state machines, not generic notes. This tool owns their current
// state and append-only transition history so the model cannot leave both the old
// and new deadline/status in Compiled Truth.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";
const ACTIONS = ["create", "reschedule", "complete", "cancel", "noop"] as const;
const SOURCE_ROLES = ["user", "forwarded", "external"] as const;
type Action = (typeof ACTIONS)[number];
type SourceRole = (typeof SOURCE_ROLES)[number];
type CommitmentStatus = "open" | "done" | "cancelled";

type CommitmentState = {
  commitmentId: string;
  title: string;
  owner: string;
  deliverable: string;
  dueAt: string;
  completedAt: string;
  status: CommitmentStatus;
  created: string;
  source: string;
  sourceRole: string;
  sources: string[];
  tags: string[];
  related: string[];
  history: string[];
  lines: string[];
};

const nonBlank = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} is required`);

const singleLine = (label: string) =>
  nonBlank(label).refine(
    (value) => !/[\r\n]/.test(value),
    `${label} must be one line`,
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaPath(): string {
  const candidates = [
    join(VAULT(), "schema.json"),
    join(VAULT(), ".claude", "skills", "autograph", "schema.json"),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function commitmentDirectory(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(schemaPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.node_types)) return null;
    if (!isRecord(parsed.node_types.commitment)) return null;
    if (isRecord(parsed.card_type_dirs)) {
      const configured = parsed.card_type_dirs.commitment;
      if (
        typeof configured === "string" &&
        /^[\p{L}\p{N}._-]+$/u.test(configured.trim()) &&
        ![".", ".."].includes(configured.trim())
      ) {
        return configured.trim();
      }
    }
    if (isRecord(parsed.path_type_hints)) {
      for (const [prefix, type] of Object.entries(parsed.path_type_hints)) {
        const match = /^cards\/([^/]+)\/$/.exec(prefix);
        if (type === "commitment" && match) return match[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function field(fields: FmFields | null, key: string): string {
  const value = fields?.[key];
  return typeof value === "string" ? value : "";
}

function listField(fields: FmFields | null, key: string): string[] {
  const value = fields?.[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value.trim() ? [value] : [];
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean),
    ),
  ].slice(0, 6);
}

function normalizeRelated(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const display = value
      .trim()
      .replace(/^\[\[|\]\]$/g, "")
      .trim();
    const key = display.split("|", 1)[0].split("#", 1)[0].trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(display);
  }
  return normalized;
}

function sectionEntries(body: string, heading: string): string[] {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  if (sections.length !== 1) return [];
  return lines
    .slice(sections[0].start + 1, sections[0].end)
    .map((line) => line.trim())
    .filter(Boolean);
}

function relatedFromBody(body: string): string[] {
  return normalizeRelated(
    sectionEntries(body, "Related").flatMap((line) =>
      [...line.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]),
    ),
  );
}

function validMoment(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (!match || !isIsoCalendarDate(match[1])) return false;
  if (!match[2]) return true;
  return (
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    (match[4] === undefined || Number(match[4]) <= 59)
  );
}

function clean(value: string): string {
  return value.trim();
}

function readState(file: string): CommitmentState {
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  if (!parsed.fields || field(parsed.fields, "type") !== "commitment") {
    throw new Error("Existing file is not a commitment card");
  }
  const status = field(parsed.fields, "status");
  if (!(["open", "done", "cancelled"] as string[]).includes(status)) {
    throw new Error(
      `Unsupported stored commitment status: ${status || "(empty)"}`,
    );
  }
  const state: CommitmentState = {
    commitmentId: field(parsed.fields, "commitment_id"),
    title: extractH1(parsed.body) ?? field(parsed.fields, "title"),
    owner: field(parsed.fields, "owner"),
    deliverable: field(parsed.fields, "deliverable"),
    dueAt: field(parsed.fields, "due_at"),
    completedAt: field(parsed.fields, "completed_at"),
    status: status as CommitmentStatus,
    created: field(parsed.fields, "created"),
    source: field(parsed.fields, "source"),
    sourceRole: field(parsed.fields, "source_role"),
    sources: listField(parsed.fields, "sources"),
    tags: listField(parsed.fields, "tags"),
    related: relatedFromBody(parsed.body),
    history: sectionEntries(parsed.body, "History"),
    lines: parsed.lines,
  };
  for (const [key, value] of Object.entries({
    commitment_id: state.commitmentId,
    owner: state.owner,
    deliverable: state.deliverable,
    due_at: state.dueAt,
    created: state.created,
    source: state.source,
    source_role: state.sourceRole,
  })) {
    if (!value) throw new Error(`Existing commitment is missing ${key}`);
  }
  if (!validMoment(state.dueAt)) {
    throw new Error(`Existing commitment has invalid due_at: ${state.dueAt}`);
  }
  return state;
}

function historyLine(
  date: string,
  action: Exclude<Action, "create" | "noop">,
  sourceRole: SourceRole,
  source: string,
  detail: string,
  reason?: string,
): string {
  const suffix = reason ? `; reason: ${clean(reason)}` : "";
  return `- ${date}: ${action}; ${detail}; source_role=${sourceRole}; source=${source}${suffix}`;
}

function renderBody(state: CommitmentState, lastSource: string): string {
  const lines = [
    `# ${state.title}`,
    "",
    `Owner: ${state.owner}`,
    `Deliverable: ${state.deliverable}`,
    `Due: ${state.dueAt}`,
    `Status: ${state.status}`,
    `Completed: ${state.completedAt || "—"}`,
    `Source: [[${lastSource}]]`,
  ];
  if (state.history.length) {
    lines.push("", "## History", "", ...state.history);
  }
  if (state.related.length) {
    lines.push(
      "",
      "## Related",
      "",
      ...state.related.map((target) => `- [[${target}]]`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function cardContent(
  state: CommitmentState,
  lastSource: string,
  lastSourceRole: SourceRole,
): string {
  const updated = memoryWriteDate();
  const fields: FmFields = {
    type: "commitment",
    description: `${state.owner}: ${state.deliverable} (${state.status}; due ${state.dueAt})`,
    tags: state.tags,
    status: state.status,
    commitment_id: state.commitmentId,
    owner: state.owner,
    deliverable: state.deliverable,
    due_at: state.dueAt,
    completed_at: state.completedAt,
    confidence: "EXTRACTED",
    domain: "work",
    created: state.created,
    updated,
    source: state.source,
    source_role: state.sourceRole,
    last_source: lastSource,
    last_source_role: lastSourceRole,
    sources: state.sources,
  };
  return `---\n${writeFrontmatter(fields, state.lines)}\n---\n${renderBody(state, lastSource)}`;
}

function relativeVaultPath(file: string): string {
  const rel = relative(VAULT(), file);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error("Commitment path escaped the vault");
  }
  return rel.split(sep).join("/");
}

type Input = {
  action: Action;
  commitment_id: string;
  owner?: string;
  deliverable?: string;
  due_at?: string;
  completed_at?: string;
  title?: string;
  source_role: SourceRole;
  reason?: string;
  tags?: string[];
  related?: string[];
};

function validateOptionalIdentity(
  state: CommitmentState,
  input: Input,
): string | null {
  if (input.owner && clean(input.owner) !== state.owner) {
    return "owner differs from the stored commitment; create a distinct commitment_id";
  }
  if (input.deliverable && clean(input.deliverable) !== state.deliverable) {
    return "deliverable differs from the stored commitment; create a distinct commitment_id";
  }
  return null;
}

export default defineTool({
  description:
    "Deterministically create and transition a structured commitment card when schema.json enables " +
    "type=commitment. Use for every explicit promise/obligation with owner, deliverable and due date. " +
    "Actions: create, reschedule, complete, cancel, noop. The tool owns status, current truth and History; " +
    "do not represent lifecycle changes with generic write_card.",
  inputSchema: z.object({
    action: z.enum(ACTIONS),
    commitment_id: singleLine("commitment_id").describe(
      "Stable kebab-case identity reused for every lifecycle transition",
    ),
    owner: singleLine("owner").optional(),
    deliverable: singleLine("deliverable").optional(),
    due_at: singleLine("due_at")
      .optional()
      .describe("ISO date or timestamp; required for create/reschedule"),
    completed_at: singleLine("completed_at")
      .optional()
      .describe("ISO timestamp; required for complete"),
    title: singleLine("title").optional(),
    source_role: z
      .enum(SOURCE_ROLES)
      .describe(
        "Who supplied the explicit business fact; never use Iva inference",
      ),
    reason: singleLine("reason").optional(),
    tags: z.array(singleLine("tag")).max(6).optional(),
    related: z.array(singleLine("related")).max(8).optional(),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await -- Eve tools are async by contract.
  async execute(rawInput) {
    const input: Input = {
      ...rawInput,
      commitment_id: clean(rawInput.commitment_id),
      owner: rawInput.owner ? clean(rawInput.owner) : undefined,
      deliverable: rawInput.deliverable
        ? clean(rawInput.deliverable)
        : undefined,
      due_at: rawInput.due_at ? clean(rawInput.due_at) : undefined,
      completed_at: rawInput.completed_at
        ? clean(rawInput.completed_at)
        : undefined,
      title: rawInput.title ? clean(rawInput.title) : undefined,
      reason: rawInput.reason ? clean(rawInput.reason) : undefined,
      tags: rawInput.tags?.map(clean),
      related: rawInput.related?.map(clean),
    };

    const directory = commitmentDirectory();
    if (!directory) {
      return {
        ok: false,
        error:
          "Commitment cards are disabled: schema.json must define node_types.commitment and card_type_dirs.commitment",
      };
    }
    if (input.action !== "noop" && !SOURCE_ROLES.includes(input.source_role)) {
      return { ok: false, error: "Unsupported source_role" };
    }
    if (input.due_at && !validMoment(input.due_at)) {
      return { ok: false, error: `Invalid due_at: ${input.due_at}` };
    }
    if (input.completed_at && !validMoment(input.completed_at)) {
      return {
        ok: false,
        error: `Invalid completed_at: ${input.completed_at}`,
      };
    }

    const source = `daily/${memoryWriteDate()}.md`;
    const dir = join(VAULT(), "cards", directory);
    const file = join(dir, `${slugify(input.commitment_id)}.md`);
    mkdirSync(dir, { recursive: true });
    let release: (() => void) | null = null;
    try {
      release = acquireLock(file);
      const exists = existsSync(file);

      if (input.action === "create") {
        if (!input.owner || !input.deliverable || !input.due_at) {
          return {
            ok: false,
            error: "create requires owner, deliverable and due_at",
          };
        }
        if (exists) {
          const existing = readState(file);
          const same =
            existing.commitmentId === input.commitment_id &&
            existing.owner === input.owner &&
            existing.deliverable === input.deliverable &&
            existing.dueAt === input.due_at;
          return same
            ? {
                ok: true,
                action: "noop",
                file: relativeVaultPath(file),
                status: existing.status,
              }
            : {
                ok: false,
                error:
                  "commitment_id already exists with different state; use a lifecycle action or a distinct id",
              };
        }
        const state: CommitmentState = {
          commitmentId: input.commitment_id,
          title: input.title ?? `${input.owner} — ${input.deliverable}`,
          owner: input.owner,
          deliverable: input.deliverable,
          dueAt: input.due_at,
          completedAt: "",
          status: "open",
          created: memoryWriteDate(),
          source,
          sourceRole: input.source_role,
          sources: [source],
          tags: normalizeTags(["commitment", ...(input.tags ?? [])]),
          related: normalizeRelated(input.related ?? []),
          history: [],
          lines: [],
        };
        atomicWrite(file, cardContent(state, source, input.source_role));
        return {
          ok: true,
          action: "created",
          file: relativeVaultPath(file),
          status: state.status,
          commitment_id: state.commitmentId,
        };
      }

      if (!exists) {
        return {
          ok: false,
          error: `Commitment ${input.commitment_id} does not exist; use create`,
        };
      }
      const state = readState(file);
      if (state.commitmentId !== input.commitment_id) {
        return {
          ok: false,
          error: "commitment_id does not match the stored card",
        };
      }
      const identityError = validateOptionalIdentity(state, input);
      if (identityError) return { ok: false, error: identityError };
      if (input.action === "noop") {
        return {
          ok: true,
          action: "noop",
          file: relativeVaultPath(file),
          status: state.status,
        };
      }

      if (input.action === "reschedule") {
        if (!input.due_at) {
          return { ok: false, error: "reschedule requires due_at" };
        }
        if (state.status !== "open") {
          return {
            ok: false,
            error: `Cannot reschedule a ${state.status} commitment`,
          };
        }
        if (state.dueAt === input.due_at) {
          return {
            ok: true,
            action: "noop",
            file: relativeVaultPath(file),
            status: state.status,
          };
        }
        const oldDue = state.dueAt;
        state.dueAt = input.due_at;
        state.history.push(
          historyLine(
            memoryWriteDate(),
            "reschedule",
            input.source_role,
            source,
            `due_at ${oldDue} -> ${state.dueAt}`,
            input.reason,
          ),
        );
      } else if (input.action === "complete") {
        if (!input.completed_at) {
          return { ok: false, error: "complete requires completed_at" };
        }
        if (
          state.status === "done" &&
          state.completedAt === input.completed_at
        ) {
          return {
            ok: true,
            action: "noop",
            file: relativeVaultPath(file),
            status: state.status,
          };
        }
        if (state.status !== "open") {
          return {
            ok: false,
            error: `Cannot complete a ${state.status} commitment`,
          };
        }
        if (input.due_at && input.due_at !== state.dueAt) {
          return {
            ok: false,
            error:
              "due_at differs from current state; reschedule before complete",
          };
        }
        state.status = "done";
        state.completedAt = input.completed_at;
        state.history.push(
          historyLine(
            memoryWriteDate(),
            "complete",
            input.source_role,
            source,
            `status open -> done; completed_at ${state.completedAt}`,
            input.reason,
          ),
        );
      } else if (input.action === "cancel") {
        if (state.status === "cancelled") {
          return {
            ok: true,
            action: "noop",
            file: relativeVaultPath(file),
            status: state.status,
          };
        }
        if (state.status !== "open") {
          return {
            ok: false,
            error: `Cannot cancel a ${state.status} commitment`,
          };
        }
        state.status = "cancelled";
        state.history.push(
          historyLine(
            memoryWriteDate(),
            "cancel",
            input.source_role,
            source,
            "status open -> cancelled",
            input.reason,
          ),
        );
      }

      state.sources = [...new Set([...state.sources, source])];
      state.tags = normalizeTags([...state.tags, ...(input.tags ?? [])]);
      state.related = normalizeRelated([
        ...state.related,
        ...(input.related ?? []),
      ]);
      atomicWrite(file, cardContent(state, source, input.source_role));
      return {
        ok: true,
        action: input.action,
        file: relativeVaultPath(file),
        status: state.status,
        commitment_id: state.commitmentId,
        due_at: state.dueAt,
        completed_at: state.completedAt || null,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      release?.();
    }
  },
});
