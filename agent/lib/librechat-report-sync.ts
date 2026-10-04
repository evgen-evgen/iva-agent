// Materialize ordinary LibreChat conversations even when all browser tabs are closed.
// Delivery failures never remove the archived report; browser polling retries the import.
export async function syncLibreChatReports(): Promise<void> {
  const secret = process.env.LIBRECHAT_NOTIFICATION_SECRET?.trim();
  if (!secret || !process.env.LIBRECHAT_PUBLIC_URL) return;
  const port = Number(process.env.LIBRECHAT_PORT || 3080);
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/iva/notifications/sync`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new Error(`LibreChat synchronization HTTP ${response.status}`);
  } catch (error) {
    console.error(
      "[notifications] report archived; LibreChat import will retry:",
      (error as Error).message,
    );
  }
}
