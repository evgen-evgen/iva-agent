/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlobNotFoundError, LocalBlobStore } from "./blob-store.ts";
import type { TenantContext } from "./tenant-context.ts";
import { TenantStore } from "./tenant-store.ts";

function context(root: string, marker: string): TenantContext {
  const tenantId = `t_${marker.repeat(32)}`;
  const dataRoot = join(root, tenantId);
  return Object.freeze({
    tenantId,
    role: "user",
    dataRoot,
    vaultRoot: join(dataRoot, "vault"),
  });
}

test("local BlobStore saves, reads, verifies, and deletes opaque objects", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-blobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tenant = new TenantStore(context(root, "a"));
  t.after(() => tenant.close());
  const blobs = new LocalBlobStore(tenant);
  const created = blobs.save(Buffer.from("hello blob"), {
    originalName: "hello.txt",
    mediaType: "text/plain",
  });

  assert.match(created.id, /^att_[0-9a-f]{32}$/u);
  assert.equal(created.originalName, "hello.txt");
  assert.equal(created.sizeBytes, 10);
  assert.equal(blobs.read(created.id).data.toString("utf8"), "hello blob");
  assert.equal(blobs.delete(created.id), true);
  assert.equal(blobs.delete(created.id), false);
  assert.throws(() => blobs.read(created.id), BlobNotFoundError);
});

test("an attachment ID cannot resolve through another tenant store", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-blobs-cross-tenant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tenantA = new TenantStore(context(root, "a"));
  const tenantB = new TenantStore(context(root, "b"));
  t.after(() => {
    tenantA.close();
    tenantB.close();
  });
  const a = new LocalBlobStore(tenantA);
  const b = new LocalBlobStore(tenantB);
  const secret = a.save(Buffer.from("tenant-a-secret"));

  assert.throws(() => b.read(secret.id), BlobNotFoundError);
  assert.equal(b.delete(secret.id), false);
  assert.equal(a.read(secret.id).data.toString("utf8"), "tenant-a-secret");
  assert.throws(() => b.read("../../etc/passwd"), BlobNotFoundError);
});
