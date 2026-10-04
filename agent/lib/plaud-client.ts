import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnvironment } from "./plugin-child-env.ts";
import { readPluginEnv } from "./plugin-config.ts";
import { expandPluginPlaceholders, readPlugin } from "./plugin-reader.ts";
import { limitPlaudCalls } from "./plaud-call.ts";
import { dataDir } from "./data-dir.ts";
import {
  pluginDataDir,
  pluginRoot,
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
  const root = pluginRoot(dataDir(), "iva-plaud");
  const paths = { root, data: pluginDataDir(dataDir(), "iva-plaud") };
  const report = await readPlugin(root);
  const server = report.mcp.plaud;
  if (!report.manifest || server?.type !== "stdio")
    throw new Error("Plaud sync requires a valid installed stdio MCP server");
  const expand = (value: string) => expandPluginPlaceholders(value, paths);
  const cwd = server.cwd ? expand(server.cwd) : root;
  // The interactive HTTP proxy owns one session. Each import must own a separate
  // child, otherwise initializing/closing it disconnects Iva's active tools.
  // Use the same private plugin data and restricted environment as the proxy.
  const transport = new StdioClientTransport({
    command: server.command.startsWith("./")
      ? join(root, server.command.slice(2))
      : server.command,
    args: (server.args ?? []).map(expand),
    cwd: isAbsolute(cwd) ? cwd : resolve(root, cwd),
    env: childEnvironment({
      declared: Object.fromEntries(
        Object.entries(server.env ?? {}).map(([key, value]) => [
          key,
          expand(value),
        ]),
      ),
      fromEnvFile: readPluginEnv("iva-plaud"),
      paths,
      inherited: {
        // systemd starts Node by absolute path; its default PATH may omit npx.
        PATH: [dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(delimiter),
        HOME: process.env.HOME,
      },
    }) as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "iva-plaud-sync", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(
      limitPlaudCalls(async (name, args) =>
        decodePlaudResult(
          await client.callTool({ name, arguments: args }, undefined, {
            timeout: 60_000,
          }),
          name,
        ),
      ),
    );
  } finally {
    await client.close();
  }
}
