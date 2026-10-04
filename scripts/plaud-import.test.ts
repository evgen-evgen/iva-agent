/* eslint-disable @typescript-eslint/no-floating-promises -- Node test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpProxy } from "../services/mcp-proxy/proxy.ts";
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
} from "../agent/lib/plugin-reader.ts";
import { pluginDataDir, pluginRoot } from "../agent/lib/plugin-store.ts";
import {
  pendingPlaud,
  plaudKey,
  savePlaudSnapshot,
} from "../agent/lib/plaud-import.ts";

const root = mkdtempSync(join(tmpdir(), "iva-plaud-tools-"));
const vault = join(root, "vault");
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_VAULT_DIR = vault;
mkdirSync(join(vault, "cards", "meetings"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const { plaudSourceRoot, withPlaudClient } =
  await import("../agent/lib/plaud-client.ts");
const module = await import("../agent/tools/plaud_import.ts");
const tool = module.default as unknown as {
  execute: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    content?: string;
    next_offset?: number | null;
  }>;
};
const source = {
  account: "ceo",
  fileId: "one",
  metadata: { name: "Meeting" },
  transcript: "A".repeat(30000),
  notes: [],
};

test("tool reads bounded source pages and refuses to acknowledge missing, stale or outside meeting cards", async () => {
  await savePlaudSnapshot(plaudSourceRoot(), source);
  const key = plaudKey(source.account, source.fileId);
  const snapshot = (await pendingPlaud(plaudSourceRoot()))[0];
  const first = await tool.execute({ action: "read", key });
  assert.equal(first.ok, true);
  assert.equal(first.content?.length, 24000);
  assert.equal(first.next_offset, 24000);
  const second = await tool.execute({
    action: "read",
    key,
    offset: first.next_offset,
  });
  assert.equal(second.next_offset, null);
  const finish = {
    action: "finish",
    key,
    revision: snapshot.revision,
    report: "Meeting report",
  };
  assert.equal((await tool.execute(finish)).ok, false);
  const meeting = join(vault, "cards", "meetings", "one.md");
  writeFileSync(meeting, `---\ntype: meeting\n---\n${key}\nold revision`);
  assert.equal(
    (await tool.execute({ ...finish, related: ["cards/meetings/one.md"] })).ok,
    false,
  );
  const outside = join(root, "outside.md");
  writeFileSync(
    outside,
    `---\ntype: meeting\n---\n${key}\n${snapshot.revision}`,
  );
  assert.equal(
    (await tool.execute({ ...finish, related: [outside] })).ok,
    false,
  );
  writeFileSync(
    meeting,
    `---\ntype: meeting\n---\n${key}\n${snapshot.revision}`,
  );
  assert.equal(
    (await tool.execute({ ...finish, related: ["cards/meetings/one.md"] })).ok,
    true,
  );
  assert.equal((await pendingPlaud(plaudSourceRoot())).length, 0);
  const read = await tool.execute({ action: "read", key, offset: 24000 });
  assert.match(read.content ?? "", /Meeting report/);
});

test("sync cannot contact a removed or untrusted plugin", async () => {
  await assert.rejects(
    withPlaudClient(() => Promise.resolve(true)),
    /Install and trust/,
  );
  const custom = join(root, "data", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(
    join(custom, "plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "iva-plaud",
          source: "local",
          ref: "",
          sha: "",
          digest: "",
          enabled: true,
          trusted: false,
          installedAt: "2026-10-04",
          mcp: { plaud: { port: 8730 } },
        },
      ],
    }),
  );
  await assert.rejects(
    withPlaudClient(() => Promise.resolve(true)),
    /Install and trust/,
  );
});

test("enable refuses missing CEO schema and toggles only after the schema is present", async () => {
  assert.equal((await tool.execute({ action: "enable" })).ok, false);
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({
      node_types: { meeting: {}, commitment: {} },
      card_type_dirs: { meeting: "meetings", commitment: "commitments" },
    }),
  );
  const { readSettings, writeSettings } =
    await import("../agent/lib/settings.ts");
  const since = "2026-10-04T20:27:59.131Z";
  writeSettings({ plaudSync: { enabled: false, since } });
  assert.equal((await tool.execute({ action: "enable" })).ok, true);
  assert.deepEqual(readSettings().plaudSync, { enabled: true, since });
  assert.equal((await tool.execute({ action: "disable" })).ok, true);
  assert.deepEqual(readSettings().plaudSync, { enabled: false, since });
});

test("sync clients can close independently while interactive Plaud tools remain connected", async () => {
  const dir = process.env.ASSISTANT_DATA_DIR!;
  const installed = pluginRoot(dir, "iva-plaud");
  mkdirSync(installed, { recursive: true });
  mkdirSync(pluginDataDir(dir, "iva-plaud"), { recursive: true });
  writeFileSync(
    join(installed, "plugin.json"),
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "iva-plaud",
    }),
  );
  writeFileSync(
    join(installed, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        plaud: {
          type: "stdio",
          command: "node",
          args: [
            fileURLToPath(
              new URL("./fixtures/mcp-echo-server.ts", import.meta.url),
            ),
          ],
          env: { HOME: "${PLUGIN_DATA}" },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "custom", "plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "iva-plaud",
          source: "local",
          ref: "",
          sha: "",
          digest: "",
          enabled: true,
          trusted: true,
          installedAt: "2026-10-04",
          mcp: { plaud: { port: 8730 } },
        },
      ],
    }),
  );
  const proxy = await startMcpProxy({
    plugin: "iva-plaud",
    server: "plaud",
    port: 0,
    token: "test-token",
    dataDir: dir,
    log: () => {},
  });
  const interactive = new Client({ name: "interactive", version: "1.0.0" });
  const marker = process.env.IVA_PLAUD_PRIVATE_MARKER;
  const inheritedPath = process.env.PATH;
  process.env.IVA_PLAUD_PRIVATE_MARKER = "must-not-leak";
  try {
    await interactive.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${proxy.port}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer test-token" } } },
      ),
    );
    process.env.PATH = "/missing-systemd-node-bin";
    await withPlaudClient(async (first) => {
      await first("echo", {});
      await withPlaudClient(async (second) => {
        const result = (await second("echo", {})) as {
          env: Record<string, string>;
        };
        assert.equal(result.env.HOME, pluginDataDir(dir, "iva-plaud"));
        assert.equal(result.env.IVA_PLAUD_PRIVATE_MARKER, undefined);
      });
      // Closing the second import must not close the first or Iva's session.
      await first("echo", {});
      assert.equal(
        (await interactive.callTool({ name: "echo", arguments: {} })).isError,
        undefined,
      );
    });
    assert.equal(
      (await interactive.callTool({ name: "echo", arguments: {} })).isError,
      undefined,
    );
  } finally {
    if (inheritedPath === undefined) delete process.env.PATH;
    else process.env.PATH = inheritedPath;
    if (marker === undefined) delete process.env.IVA_PLAUD_PRIVATE_MARKER;
    else process.env.IVA_PLAUD_PRIVATE_MARKER = marker;
    await interactive.close();
    await proxy.close();
  }
});
