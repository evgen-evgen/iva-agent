import { defineDynamic, defineInstructions } from "eve/instructions";
import { tenantCoreMarkdown } from "../lib/tenant-instructions.ts";
import { withTenantStoreFromSession } from "../lib/tenant-session.ts";

// Динамическая инструкция: каждый турн инжектит CORE (vault/CORE.md) в системный
// промпт — кто пользователь, постоянные предпочтения, активные цели, указатели. Это always-on
// RAM памяти (аналог core memory у MemGPT): маленькое, переживает компактацию (инструкции —
// не часть сжимаемой истории диалога). Пишет CORE ночной rollup; живой чат правит его только
// на явное «запомни …». Clamp чистый и общий с ночным brain.
export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы CORE не «застывал» после правок.
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: withTenantStoreFromSession(ctx, (tenant) =>
          tenantCoreMarkdown(tenant.context),
        ),
      }),
  },
});
