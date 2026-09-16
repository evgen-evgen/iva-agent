const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

export function envFlag(
  value: string | undefined,
  defaultValue = true,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (FALSE_VALUES.has(normalized)) return false;
  if (TRUE_VALUES.has(normalized)) return true;
  return defaultValue;
}

export function telegramEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlag(env.TELEGRAM_ENABLED, true);
}
