import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 192 * 1024 * 1024;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const safePath = (path: string) =>
  path.length > 0 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const excluded = (name: string) =>
  [".git", "attachments"].includes(name) ||
  name.endsWith(".lock") ||
  name.endsWith(".tmp") ||
  name.includes(".tmp-");
const snapshotSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  files: z.array(
    z.object({
      path: z.string().refine(safePath),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      body: z.string(),
    }),
  ),
});
export interface VaultBackupStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
}
export function vaultBackupId(vault: string, env = process.env): string {
  const id =
    env.IVA_VAULT_BACKUP_ID || hash(Buffer.from(resolve(vault))).slice(0, 24);
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id))
    throw new Error("Invalid IVA_VAULT_BACKUP_ID");
  return id;
}
export function garageBackupStorage(env = process.env) {
  const endpoint = env.IVA_ARCHIVE_ENDPOINT;
  const accessKeyId = env.IVA_ARCHIVE_ACCESS_KEY;
  const secretAccessKey = env.IVA_ARCHIVE_SECRET_KEY;
  const bucket = env.IVA_ARCHIVE_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket)
    throw new Error(
      "Garage archive is not configured; run npm run ingestion:setup",
    );
  const client = new S3Client({
    endpoint,
    region: env.IVA_ARCHIVE_REGION || "garage",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const storage: VaultBackupStorage = {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
    },
    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
      if (!result.Body) throw new Error("Backup object is empty");
      if ((result.ContentLength ?? 0) > MAX_JSON_BYTES)
        throw new Error("Backup object exceeds size limit");
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: cursor,
          }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
        keys.push(
          ...(result.Contents ?? []).flatMap((item) =>
            item.Key ? [item.Key] : [],
          ),
        );
        cursor = result.IsTruncated ? result.NextContinuationToken : undefined;
        if (result.IsTruncated && !cursor)
          throw new Error("Incomplete backup listing");
      } while (cursor);
      return keys;
    },
  };
  return { storage, close: () => client.destroy() };
}
async function inventory(vault: string) {
  const files = new Map<string, string>();
  async function visit(relative: string) {
    for (const name of (await readdir(join(vault, relative))).sort()) {
      if (excluded(name)) continue;
      const path = relative ? `${relative}/${name}` : name;
      if (!safePath(path)) throw new Error("Unsupported vault path");
      const info = await lstat(join(vault, path), { bigint: true });
      if (info.isSymbolicLink())
        throw new Error(`Vault symlink cannot be backed up: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile())
        files.set(
          path,
          `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
        );
      else throw new Error(`Unsupported vault entry: ${path}`);
    }
  }
  const root = await lstat(vault);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Vault must be a real directory");
  await visit("");
  return files;
}
export async function backupVault(
  vault: string,
  storage: VaultBackupStorage,
  id = vaultBackupId(vault),
) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error("Invalid backup ID");
  const before = await inventory(vault);
  const files: z.infer<typeof snapshotSchema>["files"] = [];
  let size = 0;
  for (const path of before.keys()) {
    const file = await open(
      join(vault, path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || size + info.size > MAX_BYTES)
        throw new Error("Vault memory backup exceeds 128 MiB");
      const body = await file.readFile();
      size += body.length;
      if (size > MAX_BYTES)
        throw new Error("Vault memory backup exceeds 128 MiB");
      files.push({ path, sha256: hash(body), body: body.toString("base64") });
    } finally {
      await file.close();
    }
  }
  const after = await inventory(vault);
  if (JSON.stringify([...before]) !== JSON.stringify([...after]))
    throw new Error("Vault changed during backup; retry later");
  const createdAt = new Date().toISOString();
  const json = Buffer.from(JSON.stringify({ version: 1, createdAt, files }));
  if (json.length > MAX_JSON_BYTES)
    throw new Error("Vault backup manifest is too large");
  const bytes = gzipSync(json);
  const key = `vault-backups/${id}/${createdAt.replaceAll(":", "-")}-${randomUUID()}.json.gz`;
  await storage.put(key, bytes, "application/gzip");
  const restored = await storage.get(key);
  if (hash(restored) !== hash(bytes))
    throw new Error("Garage backup verification failed");
  decodeSnapshot(restored);
  const result = {
    version: 1,
    key,
    createdAt,
    files: files.length,
    bytes: size,
    sha256: hash(bytes),
  };
  // Publish only after a round trip; failed uploads never replace the last good pointer.
  await storage.put(
    `vault-backups/${id}/latest.json`,
    Buffer.from(JSON.stringify(result)),
    "application/json",
  );
  return result;
}
function decodeSnapshot(bytes: Buffer) {
  const snapshot = snapshotSchema.parse(
    JSON.parse(
      gunzipSync(bytes, { maxOutputLength: MAX_JSON_BYTES }).toString("utf8"),
    ),
  );
  const paths = new Set<string>();
  let total = 0;
  const files = snapshot.files.map((file) => {
    if (paths.has(file.path) || file.path.split("/").some(excluded))
      throw new Error("Invalid or duplicate backup path");
    paths.add(file.path);
    const body = Buffer.from(file.body, "base64");
    total += body.length;
    if (
      total > MAX_BYTES ||
      body.toString("base64") !== file.body ||
      hash(body) !== file.sha256
    )
      throw new Error("Invalid backup content or checksum");
    return { path: file.path, body };
  });
  for (const path of paths) {
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++)
      if (paths.has(parts.slice(0, n).join("/")))
        throw new Error("Conflicting backup paths");
  }
  return { createdAt: snapshot.createdAt, files };
}
export async function restoreVault(
  key: string,
  destination: string,
  storage: VaultBackupStorage,
) {
  if (!/^vault-backups\/[a-zA-Z0-9_-]{1,80}\/[^/]+\.json\.gz$/u.test(key))
    throw new Error("Invalid vault backup key");
  // Validate the whole snapshot before creating anything; existing vaults are never overwritten.
  const snapshot = decodeSnapshot(await storage.get(key));
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const file of snapshot.files) {
      const path = join(destination, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.body, { flag: "wx", mode: 0o600 });
    }
    return { files: snapshot.files.length, createdAt: snapshot.createdAt };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
export async function listVaultBackups(
  storage: VaultBackupStorage,
  id: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error("Invalid backup ID");
  return (await storage.list(`vault-backups/${id}/`))
    .filter((key) => key.endsWith(".json.gz"))
    .sort()
    .reverse();
}
