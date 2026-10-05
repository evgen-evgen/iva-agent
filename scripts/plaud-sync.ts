import {
  ingestionConfigured,
  claimSources,
  releaseSources,
  closeIngestion,
} from "#lib/ingestion-store.ts";
import { join } from "node:path";
import { Client } from "eve/client";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { readFile } from "node:fs/promises";
import {
  readPlaudSyncConfig,
  setPlaudSyncEnabled,
} from "#lib/plaud-settings.ts";
import { plaudSourceRoot, withPlaudClient } from "#lib/plaud-client.ts";
import {
  pendingPlaud,
  plaudKey,
  syncPlaud,
  requirePlaudMemorySchema,
} from "#lib/plaud-import.ts";

try {
  if (process.argv.includes("--enable")) {
    await requirePlaudMemorySchema(process.env.ASSISTANT_VAULT_DIR || "vault");
    setPlaudSyncEnabled(true);
  }
  if (process.argv.includes("--disable")) {
    setPlaudSyncEnabled(false);
    console.log("Plaud background sync disabled");
  } else if (
    !process.argv.includes("--scheduled") ||
    readPlaudSyncConfig().enabled
  ) {
    const { since } = readPlaudSyncConfig();
    // Page 1 each tick catches new recordings; a rotating second page reconciles old edits.
    const cursorFile = join(plaudSourceRoot(), "scan.json");
    let page = 2;
    let scanAccount: string | undefined;
    let processingAfter = "";
    try {
      const cursor = JSON.parse(await readFile(cursorFile, "utf8")) as {
        page: number;
        account?: string;
        processingAfter?: string;
      };
      if (!Number.isInteger(cursor.page) || cursor.page < 2)
        throw new Error("Invalid Plaud scan cursor");
      page = cursor.page;
      scanAccount = cursor.account;
      processingAfter = cursor.processingAfter ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = await withPlaudClient(async (call) => {
      const recent = await syncPlaud(plaudSourceRoot(), call, 1, 1, since);
      if (scanAccount !== recent.account) {
        page = 2;
        processingAfter = "";
      }
      // A new-recordings-only scope never walks the historical archive.
      if (since) return recent;
      const archive = await syncPlaud(plaudSourceRoot(), call, 1, page);
      if (recent.account !== archive.account)
        throw new Error("Plaud account changed during sync");
      return {
        ...archive,
        checked: recent.checked + archive.checked,
        imported: recent.imported + archive.imported,
        errors: [...recent.errors, ...archive.errors],
      };
    });
    const queued = result.pending
      .map((item) => ({
        key: plaudKey(item.account, item.fileId),
        revision: item.revision,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    // Rotate the processing queue too: one persistently failing source cannot starve others.
    let selected = [
      ...queued.filter((item) => item.key > processingAfter),
      ...queued.filter((item) => item.key <= processingAfter),
    ].slice(0, 5);
    if (ingestionConfigured()) selected = await claimSources(selected);
    await writeFileAtomic(
      cursorFile,
      JSON.stringify({
        page: result.exhausted ? 2 : result.nextPage,
        account: result.account,
        processingAfter: selected.at(-1)?.key ?? processingAfter,
      }),
      { mode: 0o600 },
    );
    console.log(
      `Plaud: checked ${result.checked}, imported ${result.imported}, pending ${result.pending.length}, errors ${result.errors.length}`,
    );
    try {
      if (selected.length) {
        await requirePlaudMemorySchema(
          process.env.ASSISTANT_VAULT_DIR || "vault",
        );
        const client = new Client({
          host:
            process.env.ASSISTANT_HOST ??
            `http://127.0.0.1:${process.env.IVA_PORT ?? "8723"}`,
          ...(process.env.ASSISTANT_BEARER
            ? {
                auth: {
                  bearer: () => Promise.resolve(process.env.ASSISTANT_BEARER!),
                },
              }
            : {}),
        });
        const response = await client
          .session()
          .send(
            "Load the plaud-process skill. Process these already archived sources using plaud_import read and finish (do not synchronize again): " +
              JSON.stringify(selected) +
              ". Save linked meeting memory and explicit commitments. Do not send messages or notifications. Return only processed counts and errors, no source text.",
          );
        const outcome = await response.result();
        if (outcome.status === "failed")
          throw new Error(
            "Plaud context processing failed; sources remain pending",
          );
        const remaining = await pendingPlaud(
          plaudSourceRoot(),
          result.account,
          since,
        );
        if (
          selected.some((item) =>
            remaining.some(
              (pending) =>
                plaudKey(pending.account, pending.fileId) === item.key,
            ),
          )
        ) {
          throw new Error(
            "Plaud context processing left selected sources pending; retry on next tick",
          );
        }
        console.log("Plaud context-processing turn finished");
      }
      if (result.errors.length)
        throw new Error(
          "Some Plaud sources failed to import; they will be retried",
        );
    } finally {
      if (ingestionConfigured()) await releaseSources(selected);
    }
  }
} finally {
  await closeIngestion();
}
