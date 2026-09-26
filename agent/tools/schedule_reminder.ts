import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleReminder } from "../lib/reminder-schedule.js";

export default defineTool({
  description:
    "Создать одноразовое напоминание и проверить системный таймер. " +
    "Для 'через N минут/часов' передай delaySeconds; для конкретной даты — at в локальном времени сервера. " +
    "Не используй bash/systemd-run для напоминаний. Подтверждай создание только при ok=true.",
  inputSchema: z
    .object({
      text: z.string().min(1).describe("Что напомнить"),
      delaySeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Задержка в секундах для относительного времени"),
      at: z
        .string()
        .min(1)
        .optional()
        .describe("Абсолютное локальное время: YYYY-MM-DD HH:MM:SS"),
    })
    .refine(
      (value) =>
        (value.delaySeconds === undefined) !== (value.at === undefined),
      {
        message: "Укажите ровно одно: delaySeconds или at",
      },
    ),
  async execute(input) {
    try {
      return await scheduleReminder(input);
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
