import { resolve } from "node:path";
import {
  backupVault,
  garageBackupStorage,
  listVaultBackups,
  restoreVault,
  vaultBackupId,
} from "./lib/vault-backup.ts";

const vault = resolve(process.env.ASSISTANT_VAULT_DIR || "vault");
const command = process.argv[2] || "save";
if (!["save", "list", "restore"].includes(command))
  throw new Error("Use save, list, or restore <backup-key> <new-directory>");
if (command === "restore" && (!process.argv[3] || !process.argv[4]))
  throw new Error(
    "Use restore <backup-key> <new-directory>; existing directories are refused",
  );
const { storage, close } = garageBackupStorage();
try {
  const result =
    command === "list"
      ? await listVaultBackups(storage, vaultBackupId(vault))
      : command === "restore"
        ? await restoreVault(process.argv[3], resolve(process.argv[4]), storage)
        : await backupVault(vault, storage);
  console.log(JSON.stringify(result, null, 2));
} finally {
  close();
}
