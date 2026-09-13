import { defineHook } from "eve/hooks";
// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/lib/telegram-inbound.ts).
import { appendDaily } from "../lib/vault-daily.js";

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event) => {
      // CEO-memory evals query immutable vault snapshots. Writing those answers back into
      // the same vault would let later questions retrieve earlier answers and inflate recall.
      if (process.env.IVA_DISABLE_TRANSCRIPT === "1") return;
      if (event.data.finishReason === "tool-calls") return;
      const text = (event.data.message ?? "").trim();
      if (!text) return;
      appendDaily("[iva]", text);
    },
  },
});
