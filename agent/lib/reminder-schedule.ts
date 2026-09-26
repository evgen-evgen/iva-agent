import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type CommandResult = { readonly stdout: string; readonly stderr: string };
export type ReminderCommand = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<CommandResult>;

const runCommand: ReminderCommand = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${file} failed: ${String(stderr || error.message).trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export type ReminderScheduleInput = {
  readonly text: string;
  readonly delaySeconds?: number;
  readonly at?: string;
};

export async function scheduleReminder(
  input: ReminderScheduleInput,
  dependencies: {
    readonly root?: string;
    readonly node?: string;
    readonly run?: ReminderCommand;
    readonly id?: string;
  } = {},
) {
  const text = input.text.trim();
  if (!text) throw new Error("Текст напоминания пуст");
  const hasDelay = input.delaySeconds !== undefined;
  const hasAt = input.at !== undefined && input.at.trim() !== "";
  if (hasDelay === hasAt) {
    throw new Error("Укажите ровно одно: delaySeconds или at");
  }
  if (
    hasDelay &&
    (!Number.isInteger(input.delaySeconds) || input.delaySeconds < 1)
  ) {
    throw new Error("delaySeconds должен быть положительным целым числом");
  }

  const root = dependencies.root ?? process.cwd();
  const node = dependencies.node ?? process.execPath;
  const envFile = join(root, ".env");
  const cli = join(root, "bin", "iva.mjs");
  if (!existsSync(envFile) || !existsSync(cli)) {
    throw new Error(
      `Корень Ивы определён неверно (${root}): нет .env или bin/iva.mjs`,
    );
  }

  const unit = `iva-ceo-reminder-${dependencies.id ?? randomUUID().slice(0, 12)}`;
  const trigger = hasDelay
    ? `--on-active=${String(input.delaySeconds)}s`
    : `--on-calendar=${input.at!.trim()}`;
  const run = dependencies.run ?? runCommand;
  const created = await run(
    "systemd-run",
    [
      "--user",
      trigger,
      `--unit=${unit}`,
      `--working-directory=${root}`,
      "--",
      node,
      `--env-file=${envFile}`,
      cli,
      "remind",
      text,
    ],
    { cwd: root },
  );
  const checked = await run(
    "systemctl",
    ["--user", "is-active", `${unit}.timer`],
    { cwd: root },
  );
  if (checked.stdout.trim() !== "active") {
    throw new Error(`Таймер ${unit}.timer создан, но не активен`);
  }

  return {
    ok: true as const,
    unit: `${unit}.timer`,
    trigger: hasDelay
      ? { delaySeconds: input.delaySeconds }
      : { at: input.at!.trim() },
    text,
    systemd: created.stderr.trim() || created.stdout.trim(),
  };
}
