import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

export type Source = {
  provider: string;
  account: string;
  externalId: string;
  key: string;
  revision: string;
  metadata: Record<string, unknown>;
  raw: unknown;
};
let database: ReturnType<typeof postgres> | undefined;
let archive: S3Client | undefined;
export const ingestionConfigured = () =>
  Boolean(process.env.IVA_METADATA_DATABASE_URL);
function sql() {
  const url = process.env.IVA_METADATA_DATABASE_URL;
  if (!url) throw new Error("Metadata PostgreSQL is not configured");
  return (database ??= postgres(url, {
    max: 4,
    idle_timeout: 10,
    connect_timeout: 5,
  }));
}
function s3() {
  const endpoint = process.env.IVA_ARCHIVE_ENDPOINT;
  const accessKeyId = process.env.IVA_ARCHIVE_ACCESS_KEY;
  const secretAccessKey = process.env.IVA_ARCHIVE_SECRET_KEY;
  if (
    !endpoint ||
    !accessKeyId ||
    !secretAccessKey ||
    !process.env.IVA_ARCHIVE_BUCKET
  )
    throw new Error("S3 archive is not configured");
  return (archive ??= new S3Client({
    endpoint,
    region: process.env.IVA_ARCHIVE_REGION || "garage",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }));
}
export async function archiveJSON(key: string, value: unknown) {
  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.IVA_ARCHIVE_BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: "application/json",
    }),
  );
}
export async function readArchiveJSON(key: string): Promise<unknown> {
  const result = await s3().send(
    new GetObjectCommand({ Bucket: process.env.IVA_ARCHIVE_BUCKET, Key: key }),
  );
  if (!result.Body) throw new Error("Archive object is empty");
  return JSON.parse(await result.Body.transformToString()) as unknown;
}
export async function initializeIngestion() {
  await sql().unsafe(`CREATE SCHEMA IF NOT EXISTS iva_ingestion;
CREATE TABLE IF NOT EXISTS iva_ingestion.sources (
 source_key text PRIMARY KEY, provider text NOT NULL, account text NOT NULL, external_id text NOT NULL,
 revision text NOT NULL, metadata jsonb NOT NULL, raw_key text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,account,external_id));
CREATE TABLE IF NOT EXISTS iva_ingestion.jobs (
 source_key text NOT NULL REFERENCES iva_ingestion.sources(source_key), revision text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','processing','done','excluded')), attempts integer NOT NULL DEFAULT 0,
 lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), analysis_key text, report_id text,
 PRIMARY KEY(source_key,revision));
ALTER TABLE iva_ingestion.jobs ADD COLUMN IF NOT EXISTS lease_token text;
CREATE INDEX IF NOT EXISTS ingestion_pending ON iva_ingestion.jobs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS iva_ingestion.cursors (
 provider text NOT NULL, account text NOT NULL, mailbox text NOT NULL DEFAULT '', cursor jsonb NOT NULL,
 PRIMARY KEY(provider,account,mailbox));`);
  await s3().send(
    new HeadBucketCommand({ Bucket: process.env.IVA_ARCHIVE_BUCKET }),
  );
}
export async function storeSource(
  source: Source,
  status: "pending" | "excluded" = "pending",
) {
  const rawKey = `sources/${source.provider}/${source.key}/${source.revision}.json`;
  await archiveJSON(rawKey, source.raw);
  await sql().begin(async (tx) => {
    await tx`INSERT INTO iva_ingestion.sources (source_key,provider,account,external_id,revision,metadata,raw_key)
      VALUES (${source.key},${source.provider},${source.account},${source.externalId},${source.revision},${tx.json(source.metadata as postgres.JSONValue)},${rawKey})
      ON CONFLICT (source_key) DO UPDATE SET revision=EXCLUDED.revision,metadata=EXCLUDED.metadata,raw_key=EXCLUDED.raw_key,updated_at=now()`;
    await tx`INSERT INTO iva_ingestion.jobs (source_key,revision,status) VALUES (${source.key},${source.revision},${status}) ON CONFLICT DO NOTHING`;
  });
}
export async function readSource(key: string): Promise<unknown> {
  const rows =
    await sql()`SELECT raw_key FROM iva_ingestion.sources WHERE source_key=${key}`;
  if (!rows[0]) throw new Error("Imported source was not found");
  return readArchiveJSON(String(rows[0].raw_key));
}
export async function listPendingSources(
  provider: string,
  account?: string,
): Promise<unknown[]> {
  const rows =
    await sql()`SELECT s.raw_key FROM iva_ingestion.sources s JOIN iva_ingestion.jobs j ON j.source_key=s.source_key AND j.revision=s.revision
   WHERE s.provider=${provider} AND (${account ?? null}::text IS NULL OR s.account=${account ?? null})
   AND j.status IN ('pending','processing') ORDER BY j.attempts,s.updated_at,s.source_key`;
  return Promise.all(rows.map((row) => readArchiveJSON(String(row.raw_key))));
}
export async function finishSource(
  key: string,
  revision: string,
  analysis: unknown,
  reportId?: string,
) {
  const analysisKey = `analysis/${key}/${revision}.json`;
  await sql().begin(async (tx) => {
    const current =
      await tx`SELECT revision FROM iva_ingestion.sources WHERE source_key=${key} FOR UPDATE`;
    if (current[0]?.revision !== revision)
      throw new Error("Source changed; process the current revision first");
    const job =
      await tx`SELECT status FROM iva_ingestion.jobs WHERE source_key=${key} AND revision=${revision}`;
    if (job[0]?.status === "done") return;
    await archiveJSON(analysisKey, analysis);
    await tx`UPDATE iva_ingestion.jobs SET status='done',analysis_key=${analysisKey},report_id=${reportId ?? null},lease_until=NULL WHERE source_key=${key} AND revision=${revision}`;
  });
}
export async function listCompletedSourceReports(
  provider: string,
  account: string,
) {
  const rows =
    await sql()`SELECT j.source_key,j.revision,j.report_id FROM iva_ingestion.jobs j
    JOIN iva_ingestion.sources s ON s.source_key=j.source_key AND s.revision=j.revision
    WHERE s.provider=${provider} AND s.account=${account} AND j.status='done' AND j.report_id IS NOT NULL`;
  return rows.map((row) => ({
    key: String(row.source_key),
    revision: String(row.revision),
    reportId: String(row.report_id),
  }));
}

export async function retrySourceDelivery(key: string, revision: string) {
  await sql()`UPDATE iva_ingestion.jobs SET status='pending',lease_until=NULL,next_attempt_at=now()
    WHERE source_key=${key} AND revision=${revision} AND status='done'`;
}

export async function readSourceAnalysis(key: string): Promise<unknown> {
  const rows =
    await sql()`SELECT j.analysis_key FROM iva_ingestion.jobs j JOIN iva_ingestion.sources s ON s.source_key=j.source_key AND s.revision=j.revision WHERE s.source_key=${key} AND j.status='done'`;
  return rows[0]?.analysis_key
    ? readArchiveJSON(String(rows[0].analysis_key))
    : undefined;
}
export async function claimSources(items: { key: string; revision: string }[]) {
  const claimed: { key: string; revision: string; lease: string }[] = [];
  for (const item of items) {
    const lease = randomUUID();
    const rows =
      await sql()`UPDATE iva_ingestion.jobs SET status='processing',attempts=attempts+1,lease_token=${lease},lease_until=now()+interval '9 minutes'
      WHERE source_key=${item.key} AND revision=${item.revision} AND status IN ('pending','processing')
      AND (lease_until IS NULL OR lease_until<now()) AND next_attempt_at<=now() RETURNING source_key`;
    if (rows.length) claimed.push({ ...item, lease });
  }
  return claimed;
}
export async function releaseSources(
  items: { key: string; revision: string; lease?: string }[],
) {
  for (const item of items)
    await sql()`UPDATE iva_ingestion.jobs SET status='pending',lease_until=NULL,next_attempt_at=now()+interval '1 minute' WHERE source_key=${item.key} AND revision=${item.revision} AND status='processing' AND lease_token=${item.lease ?? null}`;
}
export async function getCursor(
  provider: string,
  account: string,
  mailbox = "",
): Promise<Record<string, unknown> | undefined> {
  const rows =
    await sql()`SELECT cursor FROM iva_ingestion.cursors WHERE provider=${provider} AND account=${account} AND mailbox=${mailbox}`;
  return rows[0]?.cursor as Record<string, unknown> | undefined;
}
export async function setCursor(
  provider: string,
  account: string,
  mailbox: string,
  cursor: Record<string, unknown>,
) {
  await sql()`INSERT INTO iva_ingestion.cursors (provider,account,mailbox,cursor) VALUES (${provider},${account},${mailbox},${sql().json(cursor as postgres.JSONValue)}) ON CONFLICT(provider,account,mailbox) DO UPDATE SET cursor=EXCLUDED.cursor`;
}
export async function closeIngestion() {
  await database?.end({ timeout: 5 });
  database = undefined;
  archive?.destroy();
  archive = undefined;
}
