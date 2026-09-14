import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@iva/data-dir";
import { resolveTimeZone } from "@iva/timezone";

// Динамическая инструкция: каждый турн инжектит текущие дату/время в часовом поясе
// пользователя в системный промпт. Локаль следует за языком интерфейса (кнопка в /menu
// пишет data/settings.json на лету), поэтому язык пересчитывается КАЖДЫЙ турн, а не
// захватывается на загрузке модуля. Зависит только от eve, локальных пакетов и node fs/path/Intl.
const TIMEZONE = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
const DATA_DIR = resolveDataDir(process.cwd());
const MEMORY_EVAL_MODE_ENV = "IVA_MEMORY_EVAL_MODE";
const MEMORY_EVAL_DATE_FILE = "memory-eval-date";

// settings.language ("ru"|"en") → env AGENT_LANGUAGE → "ru". Продублировано инлайн, а
// НЕ импортом agent/lib/i18n.ts: инструкции самодостаточны (гоча eve 0.11.4 —
// authored-модули проекта тут не резолвятся). Путь относителен cwd (iva.service стартует
// с WorkingDirectory=/home/shima/iva), как VAULT в 20-core.ts. Ошибки/битый JSON молча
// → env-фолбэк.
function resolveLang(
  dataDir = DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dataDir, "settings.json"), "utf8"),
    );
    const language =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).language
        : undefined;
    if (language === "ru" || language === "en") return language;
  } catch {
    // нет файла / нет доступа / битый JSON — берём язык из env-фолбэка ниже.
  }
  return env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

function evalCalendarDate(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (env[MEMORY_EVAL_MODE_ENV] !== "1") return null;
  const value = readFileSync(
    join(dataDir, MEMORY_EVAL_DATE_FILE),
    "utf8",
  ).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `${MEMORY_EVAL_DATE_FILE} must contain a valid YYYY-MM-DD date`,
    );
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(
      `${MEMORY_EVAL_DATE_FILE} must contain a valid YYYY-MM-DD date`,
    );
  }
  return value;
}

export function nowMarkdown({
  dataDir = DATA_DIR,
  env = process.env,
  timezone = TIMEZONE,
  now = new Date(),
}: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  timezone?: string;
  now?: Date;
} = {}): string {
  const lang = resolveLang(dataDir, env);
  const locale = lang === "en" ? "en-US" : "ru-RU";
  const evalDate = evalCalendarDate(dataDir, env);

  if (evalDate) {
    const [year, month, day] = evalDate.split("-").map(Number);
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));

    return lang === "en"
      ? `Current user date: ${formatted} (${evalDate}), timezone ${timezone}. Time is frozen for this isolated benchmark.`
      : `Текущая дата пользователя: ${formatted} (${evalDate}), часовой пояс ${timezone}. Время заморожено для изолированного теста.`;
  }

  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  return lang === "en"
    ? `Current user date and time: ${formatted}, timezone ${timezone}.`
    : `Текущая дата и время пользователя: ${formatted}, часовой пояс ${timezone}.`;
}

export default defineDynamic({
  events: {
    // turn.started — пересчитывается на каждом турне, чтобы время и локаль не «застывали».
    "turn.started": () => defineInstructions({ markdown: nowMarkdown() }),
  },
});
