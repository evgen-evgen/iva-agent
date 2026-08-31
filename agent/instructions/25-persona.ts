import { defineDynamic, defineInstructions } from "eve/instructions";
import { tenantPersonaMarkdown } from "../lib/tenant-instructions.ts";
import { withTenantStoreFromSession } from "../lib/tenant-session.ts";

// Динамическая инструкция: каждый турн инжектит PERSONA Ивы (vault/PERSONA.md) в
// системный промпт — тон, инициативность, стиль ответов, настроенные тестом-квизом в
// /menu. Живёт рядом с CORE (20-core.ts): always-on, переживает компактацию
// (инструкции — не часть сжимаемой истории диалога), применяется со следующего
// сообщения без рестарта (квиз пишет файл — инструкция его подхватывает на очередном
// турне). Самодостаточна — только eve + node fs/path (гоча eve 0.11.4).
export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы смена PERSONA в /menu применялась
    // со следующего сообщения без рестарта.
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: withTenantStoreFromSession(ctx, (tenant) =>
          tenantPersonaMarkdown(tenant.context),
        ),
      }),
  },
});
