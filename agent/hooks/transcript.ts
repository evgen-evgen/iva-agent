import { defineHook } from "eve/hooks";
// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/lib/telegram-inbound.ts).
import { persistCompletedAssistantTranscript } from "../lib/transcript-persistence.js";

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event, ctx) => {
      persistCompletedAssistantTranscript(event.data, ctx);
    },
  },
});
