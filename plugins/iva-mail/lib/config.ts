export class MailError extends Error {}

export function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new MailError(`${name} must be true or false`);
}

export function envInteger(
  name: string,
  fallback: number,
  { min = 1, max = 65_535 }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new MailError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MailError(`${name} is not configured`);
  return value;
}

export function safeHeader(
  value: unknown,
  field: string,
  maxChars = 998,
): string {
  if (typeof value !== "string")
    throw new MailError(`${field} must be a string`);
  if (/[\r\n]/u.test(value))
    throw new MailError(`${field} must not contain line breaks`);
  if (value.length > maxChars)
    throw new MailError(`${field} is longer than ${maxChars} characters`);
  return value;
}

export function timeoutMs(): number {
  return envInteger("MAIL_TIMEOUT_SECONDS", 30, { min: 1, max: 300 }) * 1_000;
}
