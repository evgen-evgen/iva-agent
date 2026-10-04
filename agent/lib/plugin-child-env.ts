import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Env дочернего процесса: закрытый список, собранный из файлов плагина. */
export function childEnvironment({
  declared,
  fromEnvFile,
  paths,
  inherited,
}: {
  /** `env` из `mcp.json`, плейсхолдеры уже раскрыты. */
  readonly declared: Readonly<Record<string, string>>;
  /** Переменные из `data/custom/plugins/<name>.env`. */
  readonly fromEnvFile: Readonly<Record<string, string>>;
  readonly paths: { readonly root: string; readonly data: string };
  /** `PATH` и `HOME` процесса прокси: без них не запустится почти ничто. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  // Транспорт SDK подмешивает под наш набор `getDefaultEnvironment()` — HOME, LOGNAME,
  // PATH, SHELL, TERM, USER из env прокси. Всё, что он мог бы унести, перечислено
  // здесь явно как `undefined`: такие ключи Node в дочерний процесс не передаёт, и
  // «только свой env» остаётся правдой, а не намерением.
  for (const key of DEFAULT_INHERITED_ENV_VARS) env[key] = undefined;
  if (inherited.PATH) env.PATH = inherited.PATH;
  if (inherited.HOME) env.HOME = inherited.HOME;
  // Порядок: секреты владельца, поверх них объявления автора, поверх всего — пути,
  // которые задаёт клиент (спека §9.1; их подмену ридер и так отвергает).
  for (const [key, value] of Object.entries(fromEnvFile)) env[key] = value;
  for (const [key, value] of Object.entries(declared)) env[key] = value;
  env.PLUGIN_ROOT = paths.root;
  env.PLUGIN_DATA = paths.data;
  return env;
}
