import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  normalizeReminderInput,
  scheduleReminder,
} from "../lib/reminder-schedule.js";

export default defineTool({
  description:
    "Запланировать ВЫПОЛНЕНИЕ поручения Ивой: поиск, исследование, подготовку отчёта или плана. Для 'сделай в 16:10' и 'поищи через 5 минут' используй этот инструмент, а не schedule_reminder. В срок Ива выполняет работу, сохраняет результат во входящих Libre и сообщает о готовности в Telegram. Подтверждай только при ok=true.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe(
        "Полное поручение: что выполнить, требования к результату и необходимые ограничения",
      ),
    delaySeconds: z.number().int().nonnegative().optional(),
    at: z
      .string()
      .optional()
      .describe("YYYY-MM-DD HH:MM:SS в локальном времени сервера"),
  }),
  async execute(input) {
    try {
      return await scheduleReminder({
        ...normalizeReminderInput(input),
        mode: "task",
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
