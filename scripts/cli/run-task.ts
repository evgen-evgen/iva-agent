import type { createCliRuntime } from "./runtime.ts";

export function taskPrompt(text: string): string {
  return (
    "A scheduled assignment from the owner is due NOW. Execute the assignment yourself using your tools; do not remind the owner to do it. " +
    "Do not schedule it again or promise to do it later. Research requests require actual web research; never fabricate sources or results. " +
    "Return the completed work and practical next steps as the final Markdown report, in the owner's language. " +
    "Delivery is handled by the host: do not send messages, use Telegram tools, iva notify, or iva post. " +
    "If the work cannot be completed, clearly state the concrete blocker and what was actually done.\n\nOwner's assignment:\n" +
    text
  );
}

export function createRunTaskCommand(
  runtime: ReturnType<typeof createCliRuntime>,
  dependencies: {
    run?: (prompt: string) => Promise<{ status: string; message?: string }>;
  } = {},
) {
  return async (args: readonly string[] = []): Promise<void> => {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Usage: iva run-task <assignment>");
    // Keep authored imports lazy: the CLI also repairs broken installations.
    const { Client } = await import("eve/client");
    const store = await import("#lib/notification-store.ts");
    const { sendReportReady } = await import("../lib/report-delivery.ts");
    const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
    const { readEnvFresh } = await import("../lib/env-file.ts");
    const { telegramEnabled } = await import("#lib/feature-flags.ts");
    const { withTurnTimeout, cancelTurnQuietly, resolveTurnTimeoutMs } =
      await import("../lib/rollup-turn.ts");
    const env = await readEnvFresh(runtime.ENV_PATH);
    const host =
      env.ASSISTANT_HOST || `http://127.0.0.1:${env.IVA_PORT || "8723"}`;
    const bearer = env.ASSISTANT_BEARER;
    const client = new Client({
      host,
      ...(bearer ? { auth: { bearer: () => Promise.resolve(bearer) } } : {}),
    });
    const session = client.session();
    const bot = env.TELEGRAM_BOT_TOKEN;
    const chat = env.TELEGRAM_NOTIFICATION_CHAT_ID;
    let body: string;
    try {
      const run =
        dependencies.run ??
        (async (prompt: string) => {
          const response = await session.send(prompt);
          return response.result();
        });
      const result = await withTurnTimeout(() => run(taskPrompt(text)), {
        timeoutMs: resolveTurnTimeoutMs(env.TASK_TURN_TIMEOUT_MS),
        label: "scheduled assignment",
      });
      if (result.status === "failed" || !result.message?.trim())
        throw new Error("Iva did not return a completed assignment");
      body = result.message;
    } catch (error) {
      if (!dependencies.run) await cancelTurnQuietly(session);
      const notice = await store.createNotification({
        kind: "alert",
        source: "scheduled-task-failure",
        title: "Не удалось выполнить поручение",
        body: `Не удалось выполнить запланированное поручение:\n${text}\n\n${error instanceof Error ? error.message : String(error)}`,
      });
      if (bot && chat && telegramEnabled(env)) {
        const sent = await sendTelegramHtml(bot, chat, notice.body);
        await store.setNotificationTelegramDelivery(
          notice.id,
          sent.ok ? "sent" : "failed",
          sent.ok ? undefined : sent.error,
        );
      } else await store.setNotificationTelegramDelivery(notice.id, "skipped");
      throw error;
    }
    const report = await store.createNotification({
      kind: "report",
      source: "scheduled-task",
      title: text.slice(0, 100),
      body,
    });
    if (!bot || !chat || !telegramEnabled(env)) {
      await store.setNotificationTelegramDelivery(report.id, "skipped");
      runtime.ok("Assignment completed and saved in LibreChat");
      return;
    }
    const result = await sendReportReady(bot, chat, report);
    await store.setNotificationTelegramDelivery(
      report.id,
      result.ok ? "sent" : "failed",
      result.ok ? undefined : result.error,
    );
    if (!result.ok)
      throw new Error(
        `Report saved, but Telegram delivery failed: ${result.error}`,
      );
    runtime.ok("Assignment completed, report saved and Telegram notified");
  };
}
