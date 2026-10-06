/* eslint-disable @typescript-eslint/require-await -- Async storage doubles follow the S3 contract. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  backupVault,
  garageBackupStorage,
  listVaultBackups,
  restoreVault,
  vaultBackupId,
  type VaultBackupStorage,
} from "./vault-backup.ts";

function fixtureStorage() {
  const objects = new Map<string, Buffer>();
  const storage: VaultBackupStorage = {
    put: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    get: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Missing object");
      return Buffer.from(bytes);
    },
    list: async (prefix) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)),
  };
  return { objects, storage };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "iva-vault-backup-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void test("Garage snapshots round-trip cards, schema and journals; versions preserve deleted cards", async () =>
  fixture(async (root) => {
    const vault = join(root, "vault");
    await mkdir(join(vault, "cards", "contacts"), { recursive: true });
    await mkdir(join(vault, "daily"));
    await mkdir(join(vault, ".git"));
    await mkdir(join(vault, "attachments"));
    await mkdir(join(vault, "write.lock"));
    const contact = "---\ntype: contact\n---\n# Иван\nivan@example.com\n";
    await writeFile(join(vault, "cards", "contacts", "иван.md"), contact);
    await writeFile(join(vault, "CORE.md"), "Owner context");
    await writeFile(
      join(vault, "schema.json"),
      '{"node_types":{"contact":{}}}',
    );
    await writeFile(join(vault, "daily", "2026-10-06.md"), "Journal");
    await writeFile(join(vault, ".git", "config"), "Do not archive Git");
    await writeFile(join(vault, "attachments", "huge.bin"), "Excluded");
    await writeFile(join(vault, "partial.md.tmp-123"), "Incomplete");
    const { objects, storage } = fixtureStorage();
    const first = await backupVault(vault, storage, "ceo");
    assert.equal(first.files, 4);
    const manifest = JSON.parse(
      objects.get("vault-backups/ceo/latest.json")!.toString(),
    ) as { key: string; sha256: string };
    assert.equal(manifest.key, first.key);
    assert.equal(
      manifest.sha256,
      createHash("sha256").update(objects.get(first.key)!).digest("hex"),
    );
    const restored = join(root, "restored");
    assert.equal((await restoreVault(first.key, restored, storage)).files, 4);
    assert.equal(
      await readFile(join(restored, "cards", "contacts", "иван.md"), "utf8"),
      contact,
    );
    assert.equal(
      await readFile(join(restored, "CORE.md"), "utf8"),
      "Owner context",
    );
    await assert.rejects(access(join(restored, "attachments")));
    await rm(join(vault, "cards", "contacts", "иван.md"));
    await writeFile(join(vault, "CORE.md"), "Changed context");
    const second = await backupVault(vault, storage, "ceo");
    assert.notEqual(first.key, second.key);
    assert.equal((await listVaultBackups(storage, "ceo")).length, 2);
    assert.equal((await listVaultBackups(storage, "other")).length, 0);
    const old = join(root, "old-version");
    await restoreVault(first.key, old, storage);
    assert.equal(
      await readFile(join(old, "cards", "contacts", "иван.md"), "utf8"),
      contact,
    );
    const latest = join(root, "latest-version");
    await restoreVault(second.key, latest, storage);
    await assert.rejects(access(join(latest, "cards", "contacts", "иван.md")));
    await assert.rejects(
      restoreVault(second.key, restored, storage),
      /EEXIST/u,
    );
    assert.equal(
      await readFile(join(restored, "CORE.md"), "utf8"),
      "Owner context",
    );
  }));
void test("failed upload or corrupt read-back never replaces the last verified backup", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "CORE.md"), "Memory");
    const { objects, storage } = fixtureStorage();
    await backupVault(root, storage, "ceo");
    const last = Buffer.from(objects.get("vault-backups/ceo/latest.json")!);
    await assert.rejects(
      backupVault(
        root,
        {
          ...storage,
          put: async () => {
            throw new Error("Garage down");
          },
        },
        "ceo",
      ),
      /Garage down/u,
    );
    assert.deepEqual(objects.get("vault-backups/ceo/latest.json"), last);
    await assert.rejects(
      backupVault(
        root,
        { ...storage, get: async () => Buffer.from("Corrupt") },
        "ceo",
      ),
      /verification failed/u,
    );
    assert.deepEqual(objects.get("vault-backups/ceo/latest.json"), last);
  }));
void test("symlinks fail closed; corrupt snapshots and traversal cannot write outside the restore target", async () =>
  fixture(async (root) => {
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeFile(join(root, "secret"), "Private");
    await symlink(join(root, "secret"), join(vault, "contact.md"));
    const { objects, storage } = fixtureStorage();
    await assert.rejects(backupVault(vault, storage, "ceo"), /symlink/u);
    assert.equal(objects.size, 0);
    const key = "vault-backups/ceo/test.json.gz";
    const body = Buffer.from("abc");
    const sha256 = createHash("sha256").update(body).digest("hex");
    for (const paths of [
      ["../secret"],
      ["/secret"],
      ["cards\\evil"],
      ["cards/a", "cards/a"],
      ["cards", "cards/a"],
      [".git/config"],
      ["cards/a"],
    ]) {
      const snapshot = {
        version: 1,
        createdAt: new Date().toISOString(),
        files: paths.map((path) => ({
          path,
          sha256,
          body: body.toString("base64"),
        })),
      };
      if (paths.length === 1 && paths[0] === "cards/a")
        snapshot.files[0].sha256 = "0".repeat(64);
      objects.set(key, gzipSync(Buffer.from(JSON.stringify(snapshot))));
      await assert.rejects(restoreVault(key, join(root, "restore"), storage));
      await assert.rejects(access(join(root, "restore")));
      assert.equal(await readFile(join(root, "secret"), "utf8"), "Private");
    }
    objects.set(key, Buffer.from("Not gzip"));
    await assert.rejects(restoreVault(key, join(root, "restore"), storage));
  }));
void test("backup IDs remain stable and configuration fails without Garage, independent of PostgreSQL", () => {
  assert.equal(vaultBackupId("vault", {}), vaultBackupId("vault", {}));
  assert.equal(vaultBackupId("vault", { IVA_VAULT_BACKUP_ID: "ceo" }), "ceo");
  assert.throws(
    () => vaultBackupId("vault", { IVA_VAULT_BACKUP_ID: "../bad" }),
    /Invalid/u,
  );
  assert.throws(() => garageBackupStorage({}), /not configured/u);
});
