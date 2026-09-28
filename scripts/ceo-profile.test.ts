import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { applyCeoProfile } from "./ceo-profile.ts";

test("CEO profile stays aligned with the benchmark schema overlay", () => {
  const production = JSON.parse(
    readFileSync(new URL("../vault-profiles/ceo/schema-extension.json", import.meta.url), "utf8"),
  );
  const benchmark = JSON.parse(
    readFileSync(new URL("../evals/ceo-memory/v1/schema-ceo-extension.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(production, benchmark);
});

test("CEO schema migration merges additions, preserves custom values, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-ceo-profile-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "cards"), { recursive: true });
  const original = {
    node_types: {
      commitment: {
        description: "Owner's custom contract",
        required: ["description", "custom_field"],
        status: ["open", "done"],
        custom: true,
      },
    },
    card_type_dirs: { commitment: "commitments" },
    domain_inference: { "cards/commitments/": "custom-work" },
    path_type_hints: {},
    status_order: { open: 4, custom: 12 },
    owner_extension: { keep: true },
  };
  const schemaPath = join(vault, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(original));

  try {
    const first = applyCeoProfile(vault);
    const once = readFileSync(schemaPath, "utf8");
    const second = applyCeoProfile(vault);
    const migrated = JSON.parse(once) as typeof original & {
      node_types: Record<string, any>;
      card_type_dirs: Record<string, unknown>;
      domain_inference: Record<string, unknown>;
      status_order: Record<string, number>;
    };

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(schemaPath, "utf8"), once);
    assert.deepEqual(migrated.node_types.commitment.required, ["description", "custom_field", "tags", "status", "commitment_id", "owner", "deliverable", "due_at", "completed_at", "source", "source_role", "last_source", "last_source_role"]);
    assert.deepEqual(migrated.node_types.commitment.status, ["open", "done", "cancelled"]);
    assert.equal(migrated.node_types.commitment.description, "Owner's custom contract");
    assert.equal(migrated.node_types.commitment.custom, true);
    assert.equal(migrated.owner_extension.keep, true);
    assert.equal(migrated.card_type_dirs.meeting, "meetings");
    assert.equal(migrated.domain_inference["cards/commitments/"], "custom-work");
    assert.equal(migrated.status_order.open, 4);
    assert.equal(existsSync(join(vault, "cards", "commitments")), true);
    assert.equal(existsSync(join(vault, "cards", "meetings")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
