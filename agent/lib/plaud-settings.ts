import { z } from "zod";
import { readSettings, writeSettings } from "./settings.ts";

const configSchema = z.object({
  enabled: z.boolean().default(false),
  since: z.iso.datetime({ offset: true }).optional(),
});

export function readPlaudSyncConfig() {
  return configSchema.parse(readSettings().plaudSync ?? {});
}

export function setPlaudSyncEnabled(enabled: boolean) {
  const current = readPlaudSyncConfig();
  const next = {
    ...current,
    enabled,
    ...(enabled ? { since: current.since ?? new Date().toISOString() } : {}),
  };
  writeSettings({ plaudSync: next });
  return next;
}
