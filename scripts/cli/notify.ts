// One Telegram message, sent from the CLI. Schedules need it: `systemd-run` and cron start
// with a minimal PATH where `node` is the distribution build, which refuses to load `.ts` -
// so a reminder cannot be a small script importing project modules. The installed launcher
// carries the absolute nvm node path, which makes a subcommand the only send that survives.
import { readEnvFresh } from "../lib/env-file.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

// `../lib/telegram-send.ts` reaches the authored tree through `agent/lib/outbox.ts`, so it
// is named as a type here and loaded inside the send below: `iva repair`/`iva doctor` run
// on installs whose `agent/` is missing (scripts/authored-tree-guard.test.ts). The other
// two imports stay static — neither leaves `scripts/`.
type SendTelegramHtml =
  typeof import("../lib/telegram-send.ts").sendTelegramHtml;

export type NotifyDependencies = {
  readonly readEnv?: typeof readEnvFresh;
  readonly send?: SendTelegramHtml;
  readonly recordNotification?: (input: {
    readonly body: string;
    readonly kind: "notice";
    readonly source: string;
  }) => Promise<{ readonly id: string }>;
  readonly setTelegramDelivery?: (
    id: string,
    status: "failed" | "sent",
    error?: string,
  ) => Promise<void>;
};

/** Create the notify command without reading .env or touching the network at import time. */
export function createNotifyCommand(
  runtime: CliRuntime,
  dependencies: NotifyDependencies = {},
) {
  const { ENV_PATH, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  return async function cmdNotify(args: readonly string[] = []): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Nothing to send — usage: iva notify <text>");
    const env = await readEnv(ENV_PATH);
    const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token)
      throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");
    const chat = notificationChat(env);
    if (!chat)
      throw new Error(
        "No target chat — set TELEGRAM_NOTIFICATION_CHAT_ID in .env",
      );
    const send =
      dependencies.send ??
      (await import("../lib/telegram-send.ts")).sendTelegramHtml;
    const notificationModule =
      dependencies.recordNotification && dependencies.setTelegramDelivery
        ? undefined
        : await import("#lib/notification-store.ts");
    const notification = await (
      dependencies.recordNotification ?? notificationModule!.createNotification
    )({ body: text, kind: "notice", source: "iva-notify" });
    const result = await send(token, chat, text);
    const setDelivery =
      dependencies.setTelegramDelivery ??
      notificationModule!.setNotificationTelegramDelivery;
    await setDelivery(
      notification.id,
      result.ok ? "sent" : "failed",
      result.ok ? undefined : result.error,
    ).catch((error: unknown) =>
      console.error("Notification delivery status was not saved:", error),
    );
    if (!result.ok) throw new Error(`Telegram send failed: ${result.error}`);
    ok("Saved and sent to Telegram");
  };
}
