import { resolve } from "node:path";
import { dataDir } from "../agent/lib/data-dir.ts";
import { TenantRegistry } from "../agent/lib/tenant-registry.ts";
import {
  applyOwnerMigration,
  planOwnerMigration,
} from "./lib/tenant-owner-migration.ts";

const apply = process.argv.includes("--apply");
const root = dataDir();
const sourceVault = resolve(process.env.ASSISTANT_VAULT_DIR ?? "vault");
const registry = new TenantRegistry(resolve(root, "tenants.sqlite"));
try {
  const result = apply
    ? applyOwnerMigration({ registry, dataDir: root, sourceVault })
    : planOwnerMigration({ registry, dataDir: root, sourceVault });
  console.log(
    JSON.stringify({ mode: apply ? "apply" : "dry-run", ...result }, null, 2),
  );
} finally {
  registry.close();
}
