import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { pluginDataDir } from "./plugin-store.ts";
import { withImportClient } from "./plugin-import-client.ts";
import { limitPlaudCalls } from "./plaud-call.ts";
import { decodePlaudResult, type PlaudCall } from "./plaud-import.ts";
export const plaudSourceRoot = () =>
  join(pluginDataDir(dataDir(), "iva-plaud"), "imports");
export async function withPlaudClient<T>(
  run: (call: PlaudCall) => Promise<T>,
): Promise<T> {
  return withImportClient("iva-plaud", "plaud", (client) =>
    run(
      limitPlaudCalls(async (name, args) =>
        decodePlaudResult(
          await client.callTool({ name, arguments: args }, undefined, {
            timeout: 60_000,
          }),
          name,
        ),
      ),
    ),
  );
}
