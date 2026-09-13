/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../../scripts/lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "iva-transcript-hook-"));
const previousVault = process.env.ASSISTANT_VAULT_DIR;
const previousTimezone = process.env.ASSISTANT_TIMEZONE;
const previousDisabled = process.env.IVA_DISABLE_TRANSCRIPT;

process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";

after(() => {
  if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
  else process.env.ASSISTANT_VAULT_DIR = previousVault;
  if (previousTimezone === undefined) delete process.env.ASSISTANT_TIMEZONE;
  else process.env.ASSISTANT_TIMEZONE = previousTimezone;
  if (previousDisabled === undefined) delete process.env.IVA_DISABLE_TRANSCRIPT;
  else process.env.IVA_DISABLE_TRANSCRIPT = previousDisabled;
  rmSync(VAULT, { recursive: true, force: true });
});

const hook = (await import("../hooks/transcript.ts")).default;
const handler = (
  hook as unknown as {
    events: {
      "message.completed": (event: {
        data: { finishReason: string; message: string };
      }) => void;
    };
  }
).events["message.completed"];

test("eval mode can disable transcript writes without changing normal behavior", () => {
  process.env.IVA_DISABLE_TRANSCRIPT = "1";
  handler({ data: { finishReason: "stop", message: "benchmark answer" } });
  assert.equal(existsSync(join(VAULT, "daily")), false);

  delete process.env.IVA_DISABLE_TRANSCRIPT;
  handler({ data: { finishReason: "stop", message: "normal answer" } });
  const files = readdirSync(join(VAULT, "daily"));
  assert.equal(files.length, 1);
  assert.match(
    readFileSync(join(VAULT, "daily", files[0]), "utf8"),
    /normal answer/,
  );
});
