// Private Telegram users are admitted automatically and persisted in the tenant
// registry. Environment configuration grants installation ownership only.
type TelegramAccessEnvironment = {
  readonly TELEGRAM_OWNER_USER_IDS?: string;
};

function telegramIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((id) => /^[1-9][0-9]*$/u.test(id)),
  );
}

export function ownerTelegramUsers(
  env: TelegramAccessEnvironment = process.env,
): ReadonlySet<string> {
  return telegramIds(env.TELEGRAM_OWNER_USER_IDS);
}

export function validateTelegramOwnerConfiguration(
  env: TelegramAccessEnvironment = process.env,
): void {
  const configured = (env.TELEGRAM_OWNER_USER_IDS ?? "")
    .split(/[,\s]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const owner of configured) {
    if (!/^[1-9][0-9]*$/u.test(owner)) {
      throw new Error(`Invalid Telegram owner ID: ${owner}`);
    }
  }
}
