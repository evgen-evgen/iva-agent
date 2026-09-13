/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge, parseArgs, resolveCodexAuthDataDir } from "./benchmark.ts";

test("benchmark CLI defaults to a safe single stock run", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "stock",
    prepareOnly: false,
    skipQuestions: false,
  });
});

test("benchmark CLI parses explicit modes and non-model preparation", () => {
  assert.deepEqual(
    parseArgs([
      "--mode",
      "both",
      "--output",
      "data/custom-eval",
      "--prepare-only",
      "--skip-questions",
    ]),
    {
      mode: "both",
      output: "data/custom-eval",
      prepareOnly: true,
      skipQuestions: true,
    },
  );
  assert.throws(() => parseArgs(["--mode", "magic"]), /stock/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
});

test("schema overlay merges maps without dropping stock card types", () => {
  const merged = deepMerge(
    {
      node_types: { contact: { status: ["active"] } },
      card_type_dirs: { contact: "contacts" },
    },
    {
      node_types: { commitment: { status: ["open", "done"] } },
      card_type_dirs: { commitment: "commitments" },
    },
  );
  assert.deepEqual(merged.card_type_dirs, {
    contact: "contacts",
    commitment: "commitments",
  });
  assert.deepEqual(Object.keys(merged.node_types as object), [
    "contact",
    "commitment",
  ]);
});

test("Codex auth can come from the live Iva data dir without sharing eval state", () => {
  assert.equal(
    resolveCodexAuthDataDir({ ASSISTANT_DATA_DIR: "data" }, "/srv/iva-agent"),
    "/srv/iva-agent/data",
  );
  assert.equal(
    resolveCodexAuthDataDir(
      {
        ASSISTANT_DATA_DIR: "data",
        IVA_CODEX_AUTH_DATA_DIR: "/srv/live-iva/data",
      },
      "/srv/iva-agent",
    ),
    "/srv/live-iva/data",
  );
});
