/* eslint-disable @typescript-eslint/no-floating-promises -- Node test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodePlaudResult,
  finishPlaud,
  pendingPlaud,
  plaudMetadataInScope,
  plaudKey,
  readPlaudSnapshot,
  savePlaudSnapshot,
  syncPlaud,
  type PlaudCall,
} from "./plaud-import.ts";

const wrapped = (value: unknown, tag = "abcdef1234") => ({
  content: [
    {
      type: "text",
      text: `Header\n<untrusted-user-data-${tag} source="plaud-recording">\n${JSON.stringify(value)}\n</untrusted-user-data-${tag}>\nNote: signed link missing`,
    },
  ],
});
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "iva-plaud-test-"));
  const previousData = process.env.ASSISTANT_DATA_DIR;
  const previousSecret = process.env.LIBRECHAT_NOTIFICATION_SECRET;
  process.env.ASSISTANT_DATA_DIR = join(root, "data");
  delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
  try {
    await run(root);
  } finally {
    if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousData;
    if (previousSecret === undefined)
      delete process.env.LIBRECHAT_NOTIFICATION_SECRET;
    else process.env.LIBRECHAT_NOTIFICATION_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
}
const source = {
  account: "ceo",
  fileId: "meeting",
  metadata: { name: "Budget", start_at: "2026-10-01" },
  transcript: [
    { speaker: "Ivan", text: "I'll send the budget Friday", time: 42 },
  ],
  notes: [
    {
      data_content: "Budget report",
      data_link: "https://example.com/temporary",
    },
  ],
};

test("official random envelopes decode to identical data and diagnostics fail closed", () => {
  assert.deepEqual(
    decodePlaudResult(wrapped({ id: "one" })),
    decodePlaudResult(wrapped({ id: "one" }, "123456abcdef")),
  );
  assert.throws(
    () => decodePlaudResult({ isError: true, content: [] }),
    /failed/,
  );
  assert.throws(
    () =>
      decodePlaudResult({
        isError: true,
        content: [
          { type: "text", text: "Not authenticated. Please login first." },
        ],
      }),
    /account is not authenticated; sign in/u,
  );
  assert.throws(
    () =>
      decodePlaudResult({
        content: [{ type: "text", text: "Block not available" }],
      }),
    /Unexpected/,
  );
  assert.deepEqual(
    decodePlaudResult({ content: [{ type: "text", text: '{"id":"ceo"}' }] }),
    { id: "ceo" },
  );
});

test("unchanged sources deduplicate, URLs are excluded, edits preserve revisions and stale finish fails", async () =>
  fixture(async (root) => {
    assert.equal(await savePlaudSnapshot(root, source), true);
    const first = (await pendingPlaud(root))[0];
    const key = plaudKey(source.account, source.fileId);
    assert.equal(
      await savePlaudSnapshot(root, {
        ...source,
        notes: [{ ...source.notes[0], data_link: "https://other/changed" }],
      }),
      false,
    );
    assert.equal(
      JSON.stringify(await readPlaudSnapshot(root, key)).includes("https://"),
      false,
    );
    await finishPlaud(
      root,
      key,
      first.revision,
      "Ivan promised a budget; CEO should review it",
      ["cards/meetings/budget.md"],
    );
    assert.equal((await pendingPlaud(root)).length, 0);
    assert.equal(
      await savePlaudSnapshot(root, {
        ...source,
        transcript: [{ ...source.transcript[0], text: "Monday instead" }],
      }),
      true,
    );
    const second = (await pendingPlaud(root))[0];
    assert.notEqual(second.revision, first.revision);
    assert.equal(
      (
        JSON.parse(
          await readFile(join(root, key, `${first.revision}.json`), "utf8"),
        ) as { transcript: { time: number }[] }
      ).transcript[0].time,
      42,
    );
    assert.ok(
      (await readdir(join(root, key))).includes(
        `${first.revision}.analysis.json`,
      ),
    );
    await assert.rejects(
      finishPlaud(root, key, first.revision, "stale", []),
      /Source changed/,
    );
    assert.equal((await pendingPlaud(root)).length, 1);
  }));

test("account identities are isolated, invalid keys and corrupt current files are refused", async () =>
  fixture(async (root) => {
    await savePlaudSnapshot(root, source);
    await savePlaudSnapshot(root, { ...source, account: "other" });
    assert.equal((await pendingPlaud(root, "ceo")).length, 1);
    assert.equal((await pendingPlaud(root)).length, 2);
    await assert.rejects(readPlaudSnapshot(root, "../outside"), /Invalid/);
    const key = plaudKey(source.account, source.fileId);
    await writeFile(join(root, key, "current.json"), "broken");
    await assert.rejects(savePlaudSnapshot(root, source));
    assert.equal(
      await readFile(join(root, key, "current.json"), "utf8"),
      "broken",
    );
  }));

function mockCall(): {
  call: PlaudCall;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fake async MCP boundary.
  const call: PlaudCall = async (name, args) => {
    calls.push({ name, args });
    if (name === "get_current_user") return { id: "ceo" };
    if (name === "list_files")
      return {
        data: [{ id: "meeting" }, { id: "not-ready" }, { id: "failed" }],
      };
    if (args.file_id === "failed") throw new Error("temporary failure");
    if (name === "get_file")
      return {
        id: args.file_id,
        name: "Budget",
        duration: 5000,
        presigned_url: "https://audio/secret",
      };
    if (name === "get_note") return [];
    if (name === "get_transcript") {
      if (args.file_id === "not-ready") return [];
      return {
        segments: [
          {
            text: args.cursor ? "second" : "first",
            time: args.cursor ? 12 : 0,
          },
        ],
        next_cursor: args.cursor ? null : "next",
      };
    }
    throw new Error(`Unexpected call ${name}`);
  };
  return { call, calls };
}

test("sync reads all transcript pages, keeps partial failures retryable and never downloads audio", async () =>
  fixture(async (root) => {
    const { call, calls } = mockCall();
    const result = await syncPlaud(root, call);
    assert.equal(result.imported, 1);
    assert.equal(result.checked, 3);
    assert.deepEqual(result.errors, ["failed"]);
    assert.equal(result.exhausted, true);
    assert.equal(result.pending.length, 1);
    assert.deepEqual(result.pending[0].transcript, [
      { text: "first", time: 0 },
      { text: "second", time: 12 },
    ]);
    assert.equal(
      JSON.stringify(result.pending).includes("https://audio"),
      false,
    );
    assert.equal(
      calls.filter(
        (item) =>
          item.name === "get_transcript" && item.args.file_id === "meeting",
      ).length,
      2,
    );
    assert.equal((await syncPlaud(root, call)).imported, 0);
  }));

test("repeated cursors and note-body errors do not save incomplete sources", async () =>
  fixture(async (root) => {
    const base = mockCall().call;
    const repeated: PlaudCall = async (name, args) =>
      name === "get_transcript" && args.file_id === "meeting"
        ? { segments: [{ text: "page" }], next_cursor: "same" }
        : base(name, args);
    assert.equal((await syncPlaud(root, repeated)).pending.length, 0);
    const badNote: PlaudCall = async (name, args) =>
      name === "get_note"
        ? [{ data_content_error: "expired" }]
        : base(name, args);
    assert.equal((await syncPlaud(root, badNote)).pending.length, 0);
  }));

test("bounded scans indicate coverage and accept a rotating archive page", async () =>
  fixture(async (root) => {
    const base = mockCall().call;
    const pages: number[] = [];
    const call: PlaudCall = async (name, args) => {
      if (name === "list_files") {
        pages.push(Number(args.page));
        return {
          data: Array.from({ length: 20 }, (_, n) => ({
            id: `not-ready-${n}`,
          })),
        };
      }
      if (name === "get_transcript") return [];
      return base(name, args);
    };
    const result = await syncPlaud(root, call, 1, 8);
    assert.deepEqual(pages, [8]);
    assert.equal(result.exhausted, false);
    assert.equal(result.nextPage, 9);
  }));

test("official missing/pending transaction diagnostics are skipped only for transcript calls", () => {
  for (const text of [
    'Block "transaction" not available for this recording. Available blocks: outline.',
    'Block "transaction" has no content for this recording yet.',
  ]) {
    const result = { content: [{ type: "text", text }] };
    assert.deepEqual(decodePlaudResult(result, "get_transcript"), []);
    assert.throws(
      () => decodePlaudResult(result, "get_note"),
      /Unexpected Plaud response/,
    );
  }
  assert.throws(
    () =>
      decodePlaudResult(
        { content: [{ type: "text", text: "temporary server failure" }] },
        "get_transcript",
      ),
    /Unexpected Plaud response/,
  );
});

test("explicit Plaud rate limits remain distinct from authentication failures", () => {
  assert.throws(
    () =>
      decodePlaudResult({
        isError: true,
        content: [{ type: "text", text: "API error: 429 Too Many Requests" }],
      }),
    { name: "PlaudRateLimitError" },
  );
});

test("new-only scope uses recording time and interprets timezone-free Plaud dates as UTC", () => {
  const since = "2026-10-04T20:27:59.131Z";
  assert.equal(
    plaudMetadataInScope({ start_at: "2026-10-04T20:28:00" }, since),
    true,
  );
  assert.equal(
    plaudMetadataInScope({ start_at: "2026-10-04T23:28:00+03:00" }, since),
    true,
  );
  assert.equal(
    plaudMetadataInScope(
      { start_at: "2026-10-01T00:00:00", created_at: "2026-10-05T00:00:00" },
      since,
    ),
    false,
  );
  assert.equal(
    plaudMetadataInScope({ created_at: "2026-10-04T20:28:00" }, since),
    true,
  );
  assert.equal(plaudMetadataInScope({}, since), false);
  assert.throws(() => plaudMetadataInScope({}, "broken"));
});

test("new-only sync excludes old recordings and archived backlog without downloading or deleting them", async () =>
  fixture(async (root) => {
    const since = "2026-10-04T20:27:59.131Z";
    await savePlaudSnapshot(root, {
      ...source,
      metadata: { created_at: "2026-09-01T00:00:00" },
    });
    const fetched: string[] = [];
    const call: PlaudCall = (name, args) => {
      fetched.push(
        `${name}:${typeof args.file_id === "string" ? args.file_id : ""}`,
      );
      if (name === "get_current_user") return Promise.resolve({ id: "ceo" });
      if (name === "list_files")
        return Promise.resolve({
          data: [
            { id: "old", created_at: "2026-09-01T00:00:00" },
            { id: "uploaded-old", created_at: "2026-10-05T00:00:00" },
            { id: "new", created_at: "2026-10-05T00:00:00" },
            { id: "unknown" },
          ],
        });
      if (name === "get_file")
        return Promise.resolve({
          id: args.file_id,
          ...(args.file_id === "unknown"
            ? {}
            : {
                created_at: "2026-10-05T00:00:00",
                start_at:
                  args.file_id === "uploaded-old"
                    ? "2026-09-01T00:00:00"
                    : "2026-10-05T00:00:00",
              }),
        });
      if (name === "get_transcript")
        return Promise.resolve([{ text: "New meeting" }]);
      if (name === "get_note") return Promise.resolve([]);
      throw new Error(`Unexpected call ${name}`);
    };
    const result = await syncPlaud(root, call, 1, 1, since);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.pending.map((s) => s.fileId),
      ["new"],
    );
    assert.equal(fetched.includes("get_file:old"), false);
    assert.deepEqual(
      fetched.filter((s) => s.startsWith("get_transcript:")),
      ["get_transcript:new"],
    );
    assert.equal((await pendingPlaud(root)).length, 2);
    assert.equal((await pendingPlaud(root, "ceo", since)).length, 1);
  }));
