import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dataDir } from "./data-dir.ts";
import {
  pluginDataDir,
  pluginTokenFile,
  readPluginsStateSafe,
} from "./plugin-store.ts";
import { decodePlaudResult, type PlaudCall } from "./plaud-import.ts";

export const plaudSourceRoot = () =>
  join(pluginDataDir(dataDir(), "iva-plaud"), "imports");

export async function withPlaudClient<T>(
  run: (call: PlaudCall) => Promise<T>,
): Promise<T> {
  const { state, damaged } = await readPluginsStateSafe(dataDir());
  if (damaged) throw damaged;
  const plugin = state.plugins.find((entry) => entry.name === "iva-plaud");
  const port = plugin?.mcp?.plaud?.port;
  if (!plugin?.enabled || !plugin.trusted || !port)
    throw new Error("Install and trust iva-plaud before synchronizing");
  const token = (
    await readFile(pluginTokenFile(dataDir(), "iva-plaud", "plaud"), "utf8")
  ).trim();
  if (!token) throw new Error("Plaud MCP proxy token is missing");
  const client = new Client({ name: "iva-plaud-sync", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  try {
    await client.connect(transport);
    return await run(async (name, args) =>
      decodePlaudResult(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: 60_000,
        }),
      ),
    );
  } finally {
    await client.close();
  }
}
