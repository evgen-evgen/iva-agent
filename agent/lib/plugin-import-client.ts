import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnvironment } from "./plugin-child-env.ts";
import { readPluginEnv } from "./plugin-config.ts";
import { expandPluginPlaceholders, readPlugin } from "./plugin-reader.ts";
import { dataDir } from "./data-dir.ts";
import {
  pluginDataDir,
  pluginRoot,
  readPluginsStateSafe,
} from "./plugin-store.ts";

export async function withImportClient<T>(
  pluginName: string,
  serverName: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const { state, damaged } = await readPluginsStateSafe(dataDir());
  if (damaged) throw damaged;
  const plugin = state.plugins.find((entry) => entry.name === pluginName);
  const port = plugin?.mcp?.[serverName]?.port;
  if (!plugin?.enabled || !plugin.trusted || !port)
    throw new Error(`Install and trust ${pluginName} before synchronizing`);
  const root = pluginRoot(dataDir(), pluginName);
  const paths = { root, data: pluginDataDir(dataDir(), pluginName) };
  const report = await readPlugin(root);
  const server = report.mcp[serverName];
  if (!report.manifest || server?.type !== "stdio")
    throw new Error("Import requires a valid installed stdio MCP server");
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
    env: {
      ...childEnvironment({
        declared: Object.fromEntries(
          Object.entries(server.env ?? {}).map(([key, value]) => [
            key,
            expand(value),
          ]),
        ),
        fromEnvFile: readPluginEnv(pluginName),
        paths,
        inherited: {
          // systemd starts Node by absolute path; its default PATH may omit npx.
          PATH: [dirname(process.execPath), process.env.PATH]
            .filter(Boolean)
            .join(delimiter),
          HOME: process.env.HOME,
        },
      }),
      ...(pluginName === "iva-mail" ? { MAIL_ALLOW_SEND: "false" } : {}),
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "iva-import", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}
