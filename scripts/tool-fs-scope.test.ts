/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";

const sandbox = mkdtempSync(join(tmpdir(), "iva-tool-fs-scope-"));
const vault = join(sandbox, "vault");
const readOnly = join(sandbox, "instructions");
const outside = join(sandbox, "outside");
mkdirSync(vault, { recursive: true });
mkdirSync(readOnly, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(vault, "inside.md"), "scope-token inside\n");
writeFileSync(join(readOnly, "rules.md"), "read-only instructions\n");
writeFileSync(join(outside, "secret.md"), "scope-token secret\n");
symlinkSync(outside, join(vault, "escape"), "dir");

process.env.ASSISTANT_VAULT_DIR = vault;
process.env.IVA_TOOL_FS_ROOT = vault;
process.env.IVA_TOOL_FS_READ_ROOTS = readOnly;
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

const { default: bash } = await import("../agent/tools/bash.ts");
const { default: glob } = await import("../agent/tools/glob.ts");
const { default: grep } = await import("../agent/tools/grep.ts");
const { default: readFileTool } = await import("../agent/tools/read_file.ts");
const { default: writeCardTool } = await import("../agent/tools/write_card.ts");
const { default: writeFileTool } = await import("../agent/tools/write_file.ts");

function toolContext(toolName: string): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "tool-fs-scope",
    toolName,
    session: {
      id: "tool-fs-scope",
      auth: { current: null, initiator: null },
      turn: { id: "tool-fs-scope", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

function errorMessage(result: unknown): string {
  assert.ok(
    typeof result === "object" && result !== null && "error" in result,
    "expected a structured tool error",
  );
  return String(result.error);
}

test("scoped write_file roots relative paths in the vault", async () => {
  const result = settled(
    await writeFileTool.execute(
      { path: "summaries/daily/2026-09-07.md", content: "summary\n" },
      toolContext("write_file"),
    ),
  );
  const expected = join(vault, "summaries", "daily", "2026-09-07.md");
  assert.equal(result.ok, true);
  assert.equal(result.path, expected);
  assert.equal(readFileSync(expected, "utf8"), "summary\n");
});

test("scoped file tools reject traversal, absolute escapes, and symlinks", async () => {
  const traversal = settled(
    await writeFileTool.execute(
      { path: "../escaped.md", content: "escaped\n" },
      toolContext("write_file"),
    ),
  );
  assert.equal(traversal.ok, false);
  assert.match(String(traversal.error), /outside the isolated file scope/u);
  assert.equal(existsSync(join(sandbox, "escaped.md")), false);

  const absolute = settled(
    await readFileTool.execute(
      { path: join(outside, "secret.md") },
      toolContext("read_file"),
    ),
  );
  assert.match(errorMessage(absolute), /outside the isolated file scope/u);
  assert.equal(absolute.content, "");

  const symlink = settled(
    await readFileTool.execute(
      { path: "escape/secret.md" },
      toolContext("read_file"),
    ),
  );
  assert.match(errorMessage(symlink), /symlink/u);
  assert.equal(symlink.content, "");

  const symlinkWrite = settled(
    await writeFileTool.execute(
      { path: "escape/new.md", content: "escaped\n" },
      toolContext("write_file"),
    ),
  );
  assert.equal(symlinkWrite.ok, false);
  assert.match(String(symlinkWrite.error), /symlink/u);
  assert.equal(existsSync(join(outside, "new.md")), false);
});

test("scoped reads allow explicit product instructions but never writes there", async () => {
  const read = settled(
    await readFileTool.execute(
      { path: join(readOnly, "rules.md") },
      toolContext("read_file"),
    ),
  );
  assert.equal(read.content, "read-only instructions\n");

  const write = settled(
    await writeFileTool.execute(
      { path: join(readOnly, "rules.md"), content: "modified\n" },
      toolContext("write_file"),
    ),
  );
  assert.equal(write.ok, false);
  assert.equal(
    readFileSync(join(readOnly, "rules.md"), "utf8"),
    "read-only instructions\n",
  );
});

test("scoped grep and glob cannot discover files outside the vault", async () => {
  const search = settled(
    await grep.execute({ pattern: "scope-token" }, toolContext("grep")),
  );
  assert.equal(search.count, 1);
  assert.equal(search.matches[0]?.file, join(vault, "inside.md"));

  const listing = settled(
    await glob.execute(
      { pattern: "**/*.md", cwd: outside },
      toolContext("glob"),
    ),
  );
  assert.match(errorMessage(listing), /outside the isolated file scope/u);
});

test("host bash is disabled whenever a file scope is active", async () => {
  const marker = join(outside, "bash-ran");
  const result = settled(
    await bash.execute(
      { command: `touch ${JSON.stringify(marker)}` },
      toolContext("bash"),
    ),
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /disabled in this isolated run/u);
  assert.equal(existsSync(marker), false);
});

test("read-only scoped vault rejects write_file and write_card", async () => {
  process.env.IVA_TOOL_FS_READ_ONLY = "1";
  try {
    const file = settled(
      await writeFileTool.execute(
        { path: "summaries/daily/read-only.md", content: "nope\n" },
        toolContext("write_file"),
      ),
    );
    assert.equal(file.ok, false);
    assert.match(String(file.error), /read-only/u);

    const card = settled(
      await writeCardTool.execute(
        {
          operation: "ADD",
          type: "contact",
          title: "Read Only",
          description: "Must not be created",
          tags: ["test"],
          body: "No write is allowed.",
        },
        toolContext("write_card"),
      ),
    );
    assert.equal(card.ok, false);
    assert.match(String(card.error), /read-only/u);
    assert.equal(
      existsSync(join(vault, "cards", "contacts", "read-only.md")),
      false,
    );
  } finally {
    delete process.env.IVA_TOOL_FS_READ_ONLY;
  }
});
