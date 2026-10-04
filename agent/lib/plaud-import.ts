import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomic,
} from "./fs-atomic.ts";

export type PlaudCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
const object = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({
  account: z.string(),
  fileId: z.string(),
  revision: z.string(),
  importedAt: z.string(),
  metadata: object,
  transcript: z.unknown(),
  notes: z.array(object),
});
export type PlaudSnapshot = z.infer<typeof snapshotSchema>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const plaudKey = (account: string, fileId: string) =>
  digest([account, fileId]);

// 0.3.13 wraps JSON in a fresh random untrusted-data delimiter on EVERY call.
// Decode only that envelope; never hash the wrapper or expiring signed URLs.
export function decodePlaudResult(raw: unknown): unknown {
  const result = object.parse(raw);
  if (result.isError === true)
    throw new Error(
      "Plaud MCP call failed; check authentication and server status",
    );
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(result.content);
  const text = content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  const start = text.match(
    /<(untrusted-user-data-[a-f0-9]+) source="plaud-recording">\n/,
  );
  let payload = text;
  if (start?.index !== undefined) {
    const end = text.lastIndexOf(`\n</${start[1]}>`);
    if (end < start.index) throw new Error("Malformed Plaud data envelope");
    payload = text.slice(start.index + start[0].length, end);
  }
  try {
    return JSON.parse(payload);
  } catch {
    // A transcript block may be plain text; unwrapped diagnostics are NOT data.
    if (start) return payload;
    throw new Error(
      "Unexpected Plaud response; refusing to import diagnostics as recording data",
    );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["presigned_url", "data_link"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

async function readOptional(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function locked<T>(
  root: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!/^(?:[a-f0-9]{64}|sync)$/.test(key))
    throw new Error("Invalid Plaud lock key");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await acquireFileLock(join(root, `${key}.lock`), {
    timeoutMs: 1000,
    staleMs: 30 * 60_000,
    mode: 0o600,
  });
  if (!lock) throw new Error("Plaud import busy; retry on the next tick");
  try {
    return await fn();
  } finally {
    releaseFileLock(lock);
  }
}

export async function savePlaudSnapshot(
  root: string,
  input: Omit<PlaudSnapshot, "revision" | "importedAt">,
): Promise<boolean> {
  const normalized = canonical(input) as typeof input;
  const revision = digest(normalized);
  const key = plaudKey(input.account, input.fileId);
  return locked(root, key, async () => {
    const dir = join(root, key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const current = await readOptional(join(dir, "current.json"));
    if (
      current !== undefined &&
      snapshotSchema.parse(current).revision === revision
    )
      return false;
    const snapshot = {
      ...normalized,
      revision,
      importedAt: new Date().toISOString(),
    };
    if ((await readOptional(join(dir, `${revision}.json`))) === undefined) {
      await writeFileAtomic(
        join(dir, `${revision}.json`),
        JSON.stringify(snapshot, null, 2),
        { mode: 0o600 },
      );
    }
    // Archive first, current pointer second: a crash never exposes a partial source.
    await writeFileAtomic(
      join(dir, "current.json"),
      JSON.stringify(snapshot, null, 2),
      { mode: 0o600 },
    );
    return true;
  });
}

export async function pendingPlaud(
  root: string,
  account?: string,
): Promise<PlaudSnapshot[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const pending: PlaudSnapshot[] = [];
  for (const key of entries.sort()) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue;
    const raw = await readOptional(join(root, key, "current.json"));
    if (raw === undefined) continue;
    const snapshot = snapshotSchema.parse(raw);
    if (account && snapshot.account !== account) continue;
    const done = await readOptional(join(root, key, "processed.json"));
    if (done === undefined || object.parse(done).revision !== snapshot.revision)
      pending.push(snapshot);
  }
  return pending;
}

export async function readPlaudSnapshot(
  root: string,
  key: string,
): Promise<PlaudSnapshot> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Plaud source key");
  return snapshotSchema.parse(
    await readOptional(join(root, key, "current.json")),
  );
}

export async function finishPlaud(
  root: string,
  key: string,
  revision: string,
  report: string,
  related: string[],
): Promise<void> {
  await locked(root, key, async () => {
    const snapshot = await readPlaudSnapshot(root, key);
    if (snapshot.revision !== revision)
      throw new Error(
        "Source changed; read and process the current revision first",
      );
    const dir = join(root, key);
    const processed = await readOptional(join(dir, "processed.json"));
    if (
      processed !== undefined &&
      object.parse(processed).revision === revision
    )
      return;
    // A separate derived report preserves the raw source and all older reports.
    const analysis = {
      revision,
      processedAt: new Date().toISOString(),
      report,
      related,
    };
    await writeFileAtomic(
      join(dir, `${revision}.analysis.json`),
      JSON.stringify(analysis, null, 2),
      { mode: 0o600 },
    );
    await writeFileAtomic(
      join(dir, "processed.json"),
      JSON.stringify(analysis, null, 2),
      { mode: 0o600 },
    );
  });
}

async function transcript(call: PlaudCall, fileId: string): Promise<unknown> {
  const segments: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await call("get_transcript", {
      file_id: fileId,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (typeof result === "string" || Array.isArray(result)) {
      if (page > 0)
        throw new Error("Transcript format changed during pagination");
      return result;
    }
    const batch = object.parse(result);
    segments.push(...z.array(z.unknown()).parse(batch.segments));
    if (batch.next_cursor === null || batch.next_cursor === undefined)
      return segments;
    cursor = z.string().min(1).parse(batch.next_cursor);
    if (seen.has(cursor)) throw new Error("Repeated Plaud transcript cursor");
    seen.add(cursor);
  }
  throw new Error(
    "Plaud transcript exceeds pagination limit; source was not saved",
  );
}

export async function syncPlaud(
  root: string,
  call: PlaudCall,
  maxPages = 20,
  firstPage = 1,
) {
  return locked(root, "sync", async () => {
    const user = object.parse(await call("get_current_user", {}));
    const account = z
      .union([z.string().min(1), z.number()])
      .transform(String)
      .parse(user.id ?? user.user_id);
    let imported = 0;
    let checked = 0;
    const errors: string[] = [];
    const seen = new Set<string>();
    let exhausted = false;
    let nextPage = firstPage;
    for (let offset = 0; offset < maxPages; offset++) {
      const page = firstPage + offset;
      const result = object.parse(
        await call("list_files", { page, page_size: 20 }),
      );
      const files = z.array(object).parse(result.data);
      for (const file of files) {
        const fileId = z.string().min(1).parse(file.id);
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        checked++;
        try {
          const details = object.parse(
            await call("get_file", { file_id: fileId }),
          );
          const metadata = Object.fromEntries(
            ["id", "name", "created_at", "start_at", "duration"].map((key) => [
              key,
              details[key],
            ]),
          );
          const body = await transcript(call, fileId);
          const notes = z
            .array(object)
            .parse(await call("get_note", { file_id: fileId }));
          if (notes.some((note) => note.data_content_error))
            throw new Error("Plaud note body unavailable");
          if ((!Array.isArray(body) || body.length > 0) && body !== "") {
            if (
              await savePlaudSnapshot(root, {
                account,
                fileId,
                metadata,
                transcript: body,
                notes,
              })
            )
              imported++;
          }
        } catch {
          errors.push(fileId);
        }
      }
      nextPage = page + 1;
      if (files.length < 20) {
        exhausted = true;
        nextPage = 1;
        break;
      }
    }
    return {
      account,
      imported,
      checked,
      errors,
      exhausted,
      nextPage,
      pending: await pendingPlaud(root, account),
    };
  });
}

export async function readPlaudAnalysis(
  root: string,
  key: string,
): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Plaud source key");
  return readOptional(join(root, key, "processed.json"));
}

export async function requirePlaudMemorySchema(vault: string): Promise<void> {
  const schema = object.parse(
    JSON.parse(await readFile(join(vault, "schema.json"), "utf8")),
  );
  const types = object.parse(schema.node_types);
  const dirs = object.parse(schema.card_type_dirs);
  for (const type of ["meeting", "commitment"]) {
    if (
      !types[type] ||
      typeof dirs[type] !== "string" ||
      !/^[\p{L}\p{N}._-]+$/u.test(String(dirs[type])) ||
      [".", ".."].includes(String(dirs[type]))
    ) {
      throw new Error(
        "Plaud context processing requires the CEO vault schema (meeting and commitment); enable IVA_MEMORY_PROFILE=ceo and run npm run init-vault",
      );
    }
  }
}
