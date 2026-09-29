import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const INIT_VAULT = fileURLToPath(new URL("./init-vault.mjs", import.meta.url));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-init-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeTemplate(root: string) {
  const template = join(root, "vault-template");
  mkdirSync(join(template, "cards"), { recursive: true });
  writeFileSync(join(template, "CORE.md"), "Russian core\n");
  writeFileSync(join(template, "CORE.en.md"), "English core\n");
  writeFileSync(join(template, "MOC.md"), "MOC\n");
  writeFileSync(join(template, "cards", ".gitkeep"), "");
}

function withoutGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_CONFIG_GLOBAL;
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(root, "empty-home"),
    XDG_CONFIG_HOME: join(root, "empty-xdg"),
  };
}

function runInit(root: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [INIT_VAULT], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

void test("init-vault rejects a missing template before creating a vault", async (t) => {
  const root = await sandbox(t);
  const result = runInit(root, {
    ...process.env,
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /template .* not found/u);
  assert.equal(existsSync(join(root, "live-vault")), false);
});

void test("init-vault creates the Russian template and continues without Git identity", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  });
  const vault = join(root, "live-vault");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vault created from template/u);
  assert.match(result.stderr, /first commit failed/u);
  assert.equal(readFileSync(join(vault, "CORE.md"), "utf8"), "Russian core\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
  assert.equal(readFileSync(join(vault, "MOC.md"), "utf8"), "MOC\n");
  assert.equal(existsSync(join(vault, ".git")), true);
});

void test("init-vault selects English CORE when requested", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = runInit(root, {
    ...withoutGitIdentity(root),
    AGENT_LANGUAGE: "en",
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "live-vault", "CORE.md"), "utf8"),
    "English core\n",
  );
  assert.equal(existsSync(join(root, "live-vault", "CORE.en.md")), false);
});

void test("init-vault preserves an existing vault on repeated runs", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const env = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  };
  const first = runInit(root, env);
  const vault = join(root, "live-vault");
  writeFileSync(join(vault, "personal.md"), "keep this\n");
  const second = runInit(root, env);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(
    second.stdout,
    /vault already has data; restored 0 missing template entries/u,
  );
  assert.equal(readFileSync(join(vault, "personal.md"), "utf8"), "keep this\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
});

void test("init-vault repairs only missing structure in a non-empty vault", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const vault = join(root, "live-vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "personal.md"), "private memory\n");

  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /vault already has data; restored 3 missing template entries/u,
  );
  assert.equal(
    readFileSync(join(vault, "personal.md"), "utf8"),
    "private memory\n",
  );
  assert.equal(readFileSync(join(vault, "CORE.md"), "utf8"), "Russian core\n");
  assert.equal(readFileSync(join(vault, "MOC.md"), "utf8"), "MOC\n");
  assert.equal(existsSync(join(vault, "cards", ".gitkeep")), true);
  assert.equal(existsSync(join(vault, ".git")), true);
  assert.equal(
    execFileSync("git", ["-C", vault, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).trim(),
    "true",
  );
});

void test("CEO profile is enabled on a clean production vault", async (t) => {
  const root = await sandbox(t);
  const sourceTemplate = fileURLToPath(
    new URL("../vault-template/", import.meta.url),
  );
  cpSync(sourceTemplate, join(root, "vault-template"), { recursive: true });

  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
    IVA_MEMORY_PROFILE: "ceo",
    IVA_CEO_NAME: "Evgen",
  });
  const vault = join(root, "live-vault");
  const schema = JSON.parse(
    readFileSync(join(vault, "schema.json"), "utf8"),
  ) as {
    node_types: Record<string, unknown>;
    card_type_dirs: Record<string, unknown>;
  };

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CEO profile applied/u);
  assert.ok(schema.node_types.commitment);
  assert.ok(schema.node_types.meeting);
  assert.ok(
    (schema.node_types.project as { status: string[] }).status.includes(
      "blocked",
    ),
  );
  assert.equal(schema.card_type_dirs.commitment, "commitments");
  assert.equal(schema.card_type_dirs.meeting, "meetings");
  assert.equal(existsSync(join(vault, "cards", "commitments")), true);
  assert.equal(existsSync(join(vault, "cards", "meetings")), true);
});

void test("CEO profile migrates an existing vault additively and idempotently", async (t) => {
  const root = await sandbox(t);
  const sourceTemplate = fileURLToPath(
    new URL("../vault-template/", import.meta.url),
  );
  cpSync(sourceTemplate, join(root, "vault-template"), { recursive: true });
  const vault = join(root, "live-vault");
  mkdirSync(join(vault, "cards"), { recursive: true });
  const schema = JSON.parse(
    readFileSync(join(root, "vault-template", "schema.json"), "utf8"),
  ) as Record<string, unknown>;
  schema.customer_extension = { keep: true };
  writeFileSync(join(vault, "schema.json"), JSON.stringify(schema));
  writeFileSync(join(vault, "cards", "personal.md"), "private card\n");

  const env = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
    IVA_MEMORY_PROFILE: "ceo",
  };
  const first = runInit(root, env);
  const afterFirst = readFileSync(join(vault, "schema.json"), "utf8");
  const second = runInit(root, env);
  const migrated = JSON.parse(
    readFileSync(join(vault, "schema.json"), "utf8"),
  ) as {
    customer_extension: { keep: boolean };
    node_types: Record<string, unknown>;
  };

  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /CEO profile applied/u);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /CEO profile already present/u);
  assert.equal(readFileSync(join(vault, "schema.json"), "utf8"), afterFirst);
  assert.equal(migrated.customer_extension.keep, true);
  assert.ok(migrated.node_types.commitment);
  assert.ok(migrated.node_types.meeting);
  assert.equal(
    readFileSync(join(vault, "cards", "personal.md"), "utf8"),
    "private card\n",
  );
  assert.equal(existsSync(join(vault, "cards", "commitments")), true);
  assert.equal(existsSync(join(vault, "cards", "meetings")), true);
});

// Атомарная запись оставляет временный файл рядом с данными, если писателя убили
// сигналом, а ночной brain делает `git add -A` — огрызок не должен попасть в историю
// vault. Проверяем НАСТОЯЩИМ git'ом и настоящими именами обоих писателей: python
// (tempfile.mkstemp → tmpXXXX.tmp) и TypeScript (fs-atomic → <файл>.tmp-<pid>-<uuid>).
void test("the vault template ignores half-written temp files, not real cards", async (t) => {
  const root = await sandbox(t);
  const vault = join(root, "vault");
  mkdirSync(join(vault, "cards"), { recursive: true });
  const template = fileURLToPath(
    new URL("../vault-template/.gitignore", import.meta.url),
  );
  writeFileSync(join(vault, ".gitignore"), readFileSync(template, "utf8"));

  execFileSync("git", ["-C", vault, "init", "-q"]);
  for (const name of [
    "cards/tmpjsxhjx4o.tmp",
    "cards/ivan.md.tmp-23940-c9d1d4da-9f4c-477f-ac92-7972aedd15ea",
    "cards/ivan.md",
    "MOC.md",
  ])
    writeFileSync(join(vault, name), "x\n");
  execFileSync("git", ["-C", vault, "add", "-A"]);

  const staged = execFileSync(
    "git",
    ["-C", vault, "diff", "--cached", "--name-only"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(staged, [".gitignore", "MOC.md", "cards/ivan.md"]);
});
