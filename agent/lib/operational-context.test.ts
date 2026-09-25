import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operationalContextMarkdown } from "./operational-context.ts";

test("builds one bounded working context from tasks and memory cards", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-operational-"));
  const data = join(root, "data");
  const vault = join(root, "vault");
  for (const kind of ["projects", "contacts", "decisions"])
    mkdirSync(join(vault, "cards", kind), { recursive: true });
  mkdirSync(data, { recursive: true });
  try {
    writeFileSync(join(vault, "NOW.md"), "Главный фокус — запуск общего контекста.\n");
    writeFileSync(
      join(data, "tasks.json"),
      JSON.stringify([
        { text: "Открытая задача", priority: "high", done: false },
        { text: "Закрытая задача", done: true },
      ]),
    );
    writeFileSync(
      join(vault, "cards", "projects", "alpha.md"),
      '---\ndescription: "Описание проекта"\nstatus: "active"\n---\n# Альфа\n',
    );
    writeFileSync(
      join(vault, "cards", "contacts", "dima.md"),
      '---\ndescription: "Ответственный"\nstatus: "active"\n---\n# Дима\n',
    );
    writeFileSync(
      join(vault, "cards", "decisions", "channels.md"),
      '---\ndescription: "Оставить два канала"\nstatus: "active"\n---\n# Каналы\n',
    );

    const context = operationalContextMarkdown({ dataDir: data, vaultDir: vault });
    assert.match(context, /Главный фокус/u);
    assert.match(context, /Открытая задача \(high\)/u);
    assert.doesNotMatch(context, /Закрытая задача/u);
    assert.match(context, /Альфа \(active\): Описание проекта/u);
    assert.match(context, /Дима \(active\): Ответственный/u);
    assert.match(context, /Каналы \(active\): Оставить два канала/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
