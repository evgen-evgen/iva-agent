/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { resolveTenantPath, TenantPathError } from "./tenant-path.ts";

function fixture(t: test.TestContext): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "iva-tenant-path-"));
  const root = join(base, "tenant");
  const outside = join(base, "outside");
  mkdirSync(join(root, "daily"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "daily", "today.md"), "inside");
  writeFileSync(join(outside, "secret"), "outside");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { root, outside };
}

test("tenant-relative existing and new paths resolve inside the root", (t) => {
  const { root } = fixture(t);
  assert.equal(
    resolveTenantPath(root, "daily/today.md"),
    join(root, "daily", "today.md"),
  );
  assert.equal(
    resolveTenantPath(root, "cards/new/card.md"),
    join(root, "cards", "new", "card.md"),
  );
});

test("absolute, traversal, ambiguous separators, and empty components fail uniformly", (t) => {
  const { root } = fixture(t);
  const hostile = [
    "/etc/passwd",
    "C:\\Windows\\system.ini",
    "../outside/secret",
    "daily/../../outside/secret",
    "daily\\..\\outside\\secret",
    "daily//today.md",
    "daily/./today.md",
    "",
  ];
  for (const path of hostile) {
    assert.throws(() => resolveTenantPath(root, path), TenantPathError);
  }
});

test("symlinks are rejected whether they point outside or back inside", (t) => {
  const { root, outside } = fixture(t);
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "daily"), join(root, "alias"));
  assert.throws(
    () => resolveTenantPath(root, "escape/secret"),
    TenantPathError,
  );
  assert.throws(
    () => resolveTenantPath(root, "alias/today.md"),
    TenantPathError,
  );
});

test("property: traversal prefixes and absolute roots never escape", (t) => {
  const { root } = fixture(t);
  fc.assert(
    fc.property(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9._-]{1,12}$/u), {
        minLength: 1,
        maxLength: 5,
      }),
      (segments) => {
        const suffix = segments.join("/");
        for (const hostile of [
          `../${suffix}`,
          `daily/../../${suffix}`,
          `/${suffix}`,
        ]) {
          assert.throws(
            () => resolveTenantPath(root, hostile),
            TenantPathError,
          );
        }
      },
    ),
    { numRuns: 500 },
  );
});
