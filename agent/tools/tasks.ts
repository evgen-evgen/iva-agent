import { defineTool } from "eve/tools";
import { z } from "zod";
import { withTenantStoreFromSession } from "../lib/tenant-session.js";
import { TenantTaskStore } from "../lib/tenant-tasks.js";

export default defineTool({
  description:
    "Управление списком задач пользователя. action=add добавляет задачу (нужен text); " +
    "list показывает задачи (по умолчанию незавершённые); done отмечает задачу выполненной (нужен id); " +
    "remove удаляет задачу (нужен id).",
  inputSchema: z.object({
    action: z.enum(["add", "list", "done", "remove"]),
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Текст задачи (для action=add)"),
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("ID задачи (для done/remove)"),
    priority: z
      .enum(["low", "med", "high"])
      .optional()
      .describe("Приоритет (для add)"),
    due: z
      .string()
      .optional()
      .describe("Срок в свободной форме или ISO-дата (для add)"),
    includeDone: z
      .boolean()
      .optional()
      .describe("Показать и выполненные (для list)"),
  }),
  execute({ action, text, id, priority, due, includeDone }, ctx) {
    try {
      return withTenantStoreFromSession(ctx, (tenant) => {
        const tasks = new TenantTaskStore(tenant);
        switch (action) {
          case "add": {
            if (!text) return { ok: false, error: "Для add нужен text" };
            const added = tasks.add({ text, priority, due });
            return { ok: true, added, total: tasks.list(true).length };
          }
          case "list": {
            const items = tasks.list(includeDone);
            return { ok: true, count: items.length, tasks: items };
          }
          case "done": {
            if (!id) return { ok: false, error: "Для done нужен id" };
            const done = tasks.done(id);
            return done === null
              ? { ok: false, error: `Задача ${id} не найдена` }
              : { ok: true, done };
          }
          case "remove": {
            if (!id) return { ok: false, error: "Для remove нужен id" };
            const removed = tasks.remove(id);
            return removed === null
              ? { ok: false, error: `Задача ${id} не найдена` }
              : {
                  ok: true,
                  removed,
                  total: tasks.list(true).length,
                };
          }
        }
      });
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});
