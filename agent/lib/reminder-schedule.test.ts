import assert from "node:assert/strict";
import test from "node:test";
import { scheduleReminder, type ReminderCommand } from "./reminder-schedule.ts";

const ROOT = process.cwd();

void test("relative reminders use a monotonic timer and this Iva checkout", async () => {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> =
    [];
  const run: ReminderCommand = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return Promise.resolve(
      file === "systemctl"
        ? { stdout: "active\n", stderr: "" }
        : { stdout: "", stderr: "timer created" },
    );
  };

  const result = await scheduleReminder(
    { text: "  Присесть  ", delaySeconds: 120 },
    { root: ROOT, node: "/node24", run, id: "test" },
  );

  assert.equal(result.unit, "iva-ceo-reminder-test.timer");
  assert.deepEqual(calls[0], {
    file: "systemd-run",
    cwd: ROOT,
    args: [
      "--user",
      "--on-active=120s",
      "--unit=iva-ceo-reminder-test",
      `--working-directory=${ROOT}`,
      "--",
      "/node24",
      `--env-file=${ROOT}/.env`,
      `${ROOT}/bin/iva.mjs`,
      "remind",
      "Присесть",
    ],
  });
  assert.deepEqual(calls[1]?.args, [
    "--user",
    "is-active",
    "iva-ceo-reminder-test.timer",
  ]);
});

void test("absolute reminders use on-calendar and reject ambiguous input", async () => {
  const args: Array<readonly string[]> = [];
  const run: ReminderCommand = (file, value) => {
    args.push(value);
    return Promise.resolve({
      stdout: file === "systemctl" ? "active\n" : "",
      stderr: "",
    });
  };
  await scheduleReminder(
    { text: "Встреча", at: "2026-09-27 09:00:00" },
    { root: ROOT, run, id: "absolute" },
  );
  assert.equal(args[0]?.[1], "--on-calendar=2026-09-27 09:00:00");
  await assert.rejects(
    scheduleReminder(
      { text: "Ошибка", at: "tomorrow", delaySeconds: 60 },
      { root: ROOT, run },
    ),
    /ровно одно/u,
  );
});
