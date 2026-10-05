import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { writeFileAtomicSync } from "../agent/lib/fs-atomic.ts";

let text = readFileSync(".env", "utf8");
const env = parseEnv(text);
const values = {
  IVA_POSTGRES_PASSWORD:
    env.IVA_POSTGRES_PASSWORD || randomBytes(32).toString("hex"),
  IVA_POSTGRES_PORT: env.IVA_POSTGRES_PORT || "55433",
  IVA_ARCHIVE_PORT: env.IVA_ARCHIVE_PORT || "3900",
  IVA_ARCHIVE_ACCESS_KEY:
    env.IVA_ARCHIVE_ACCESS_KEY || `GK${randomBytes(16).toString("hex")}`,
  IVA_ARCHIVE_SECRET_KEY:
    env.IVA_ARCHIVE_SECRET_KEY || randomBytes(32).toString("hex"),
  IVA_ARCHIVE_BUCKET: env.IVA_ARCHIVE_BUCKET || "iva-archive",
};
const settings = {
  ...values,
  IVA_METADATA_DATABASE_URL:
    env.IVA_METADATA_DATABASE_URL ||
    `postgres://iva:${values.IVA_POSTGRES_PASSWORD}@127.0.0.1:${values.IVA_POSTGRES_PORT}/iva_metadata`,
  IVA_ARCHIVE_ENDPOINT:
    env.IVA_ARCHIVE_ENDPOINT || `http://127.0.0.1:${values.IVA_ARCHIVE_PORT}`,
  IVA_ARCHIVE_REGION: "garage",
};
for (const [key, value] of Object.entries(settings)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  text = pattern.test(text)
    ? text.replace(pattern, () => line)
    : `${text.trimEnd()}\n${line}\n`;
}
writeFileAtomicSync(".env", text, { mode: 0o600 });
mkdirSync("data/garage", { recursive: true, mode: 0o700 });
if (!existsSync("data/garage/garage.toml"))
  writeFileSync(
    "data/garage/garage.toml",
    `metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${randomBytes(32).toString("hex")}"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
`,
    { mode: 0o600 },
  );
execFileSync(
  "docker",
  [
    "compose",
    "-p",
    "iva-agent",
    "--profile",
    "iva-data",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "60",
    "ceo-postgres",
    "ceo-archive",
  ],
  { stdio: "inherit" },
);
console.log(
  "CEO PostgreSQL and archive started; credentials saved privately in .env",
);
