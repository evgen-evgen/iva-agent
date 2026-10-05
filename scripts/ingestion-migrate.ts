import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  initializeIngestion,
  storeSource,
  finishSource,
  closeIngestion,
} from "#lib/ingestion-store.ts";
import { plaudSourceRoot } from "#lib/plaud-client.ts";
import { plaudMetadataInScope, type PlaudSnapshot } from "#lib/plaud-import.ts";
import { readPlaudSyncConfig } from "#lib/plaud-settings.ts";
let count = 0;
try {
  await initializeIngestion();
  for (const key of await readdir(plaudSourceRoot())) {
    if (!/^[a-f0-9]{64}$/u.test(key)) continue;
    const source = JSON.parse(
      await readFile(join(plaudSourceRoot(), key, "current.json"), "utf8"),
    ) as PlaudSnapshot;
    await storeSource(
      {
        provider: "plaud",
        account: source.account,
        externalId: source.fileId,
        key,
        revision: source.revision,
        metadata: source.metadata,
        raw: source,
      },
      plaudMetadataInScope(source.metadata, readPlaudSyncConfig().since)
        ? "pending"
        : "excluded",
    );
    try {
      const analysis = JSON.parse(
        await readFile(join(plaudSourceRoot(), key, "processed.json"), "utf8"),
      ) as { revision: string };
      if (analysis.revision === source.revision)
        await finishSource(key, source.revision, analysis);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    count++;
  }
  console.log(
    `Migrated ${count} existing Plaud archives; no historical sources fetched`,
  );
} finally {
  await closeIngestion();
}
