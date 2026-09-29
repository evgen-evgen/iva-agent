import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operationalContextMarkdown } from "./operational-context.ts";

void test("builds one bounded working context from tasks and memory cards", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-operational-"));
  const data = join(root, "data");
  const vault = join(root, "vault");
  for (const kind of ["projects", "contacts", "decisions", "commitments"])
    mkdirSync(join(vault, "cards", kind), { recursive: true });
  mkdirSync(data, { recursive: true });
  try {
    writeFileSync(
      join(vault, "NOW.md"),
      "Главный фокус — запуск общего контекста.\n",
    );
    writeFileSync(
      join(data, "tasks.json"),
      JSON.stringify([
        { text: "Открытая задача", priority: "high", done: false },
        { text: "Закрытая задача", done: true },
      ]),
    );
    writeFileSync(
      join(vault, "cards", "projects", "alpha.md"),
      '---\ndescription: "Описание проекта"\nstatus: "active"\nblocker: "Ждём решение клиента"\n---\n# Альфа\n',
    );
    writeFileSync(
      join(vault, "cards", "contacts", "dima.md"),
      '---\ndescription: "Ответственный"\nstatus: "active"\n---\n# Дима\n',
    );
    writeFileSync(
      join(vault, "cards", "decisions", "channels.md"),
      '---\ndescription: "Оставить два канала"\nstatus: "active"\n---\n# Каналы\n',
    );

    writeFileSync(
      join(vault, "cards", "commitments", "evgen-report.md"),
      '---\ntype: commitment\nstatus: "open"\nowner: "Evgen"\ndeliverable: "Сдать отчёт"\ndue_at: "2026-09-27"\nblocker: "Ждём клиента"\n---\n# Отчёт\n',
    );
    writeFileSync(
      join(vault, "cards", "commitments", "partner-review.md"),
      '---\ntype: commitment\nstatus: "open"\nowner: "Партнёр"\ndeliverable: "Проверить договор"\ndue_at: "2026-09-29"\n---\n# Проверка договора\n',
    );
    writeFileSync(
      join(vault, "cards", "commitments", "done.md"),
      '---\ntype: commitment\nstatus: "done"\nowner: "Evgen"\ndeliverable: "Уже завершено"\ndue_at: "2026-09-01"\n---\n# Завершено\n',
    );
    const context = operationalContextMarkdown({
      dataDir: data,
      vaultDir: vault,
      now: new Date("2026-09-28T12:00:00Z"),
      ceoName: "Evgen",
      profile: "ceo",
    });
    assert.match(context, /Главный фокус/u);
    assert.match(context, /Открытая задача \(high\)/u);
    assert.doesNotMatch(context, /Закрытая задача/u);
    assert.match(context, /Альфа \(active\): Описание проекта/u);
    assert.match(context, /Дима \(active\): Ответственный/u);
    assert.match(context, /Каналы \(active\): Оставить два канала/u);
    const overdueIndex = context.indexOf(
      "Evgen: Сдать отчёт — срок 2026-09-27",
    );
    const upcomingIndex = context.indexOf(
      "Партнёр: Проверить договор — срок 2026-09-29",
    );
    assert.ok(overdueIndex >= 0 && overdueIndex < upcomingIndex);
    assert.match(context, /ПРОСРОЧЕНО; Evgen: Сдать отчёт/u);
    assert.match(context, /Обязательства CEO[\s\S]*Evgen: Сдать отчёт/u);
    assert.match(context, /Блокеры[\s\S]*Ждём решение клиента/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("CEO deadlines use assistant timezone and only frontmatter current truth", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-ceo-context-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "cards", "promises"), { recursive: true });
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({ card_type_dirs: { commitment: "promises" } }),
  );
  writeFileSync(
    join(vault, "cards", "promises", "one.md"),
    '---\nstatus: open\nowner: "CEO"\ndeliverable: "Подписать договор"\ndue_at: "2026-09-29T09:00"\n---\n# Договор\n## History\n- status: done\n- due_at: 2026-09-01\n',
  );
  writeFileSync(
    join(vault, "cards", "promises", "broken.md"),
    "# incomplete\nstatus: open\n",
  );
  const previous = process.env.ASSISTANT_TIMEZONE;
  process.env.ASSISTANT_TIMEZONE = "Europe/Minsk";
  try {
    const before = operationalContextMarkdown({
      vaultDir: vault,
      dataDir: root,
      now: new Date("2026-09-29T05:59:00Z"),
      profile: "ceo",
    });
    const after = operationalContextMarkdown({
      vaultDir: vault,
      dataDir: root,
      now: new Date("2026-09-29T06:01:00Z"),
      profile: "ceo",
    });
    assert.match(before, /CEO: Подписать договор — срок 2026-09-29T09:00/u);
    assert.doesNotMatch(before, /ПРОСРОЧЕНО/u);
    assert.match(after, /ПРОСРОЧЕНО; CEO: Подписать договор/u);
    assert.doesNotMatch(after, /2026-09-01/u);
    const personal = operationalContextMarkdown({
      vaultDir: vault,
      dataDir: root,
      profile: "personal",
    });
    assert.doesNotMatch(personal, /Открытые обязательства/u);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_TIMEZONE;
    else process.env.ASSISTANT_TIMEZONE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
