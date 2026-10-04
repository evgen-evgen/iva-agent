/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement production Promise contracts. */
import "../../scripts/lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const channel = (await import("../channels/open-webui.ts")).default;
import {
  createNotification,
  getNotification,
  listNotifications,
} from "./notification-store.ts";

type Handler = (
  request: Request,
  context: Record<string, unknown>,
) => Promise<Response>;
function handler(method: string, path: string): Handler {
  const route = channel.routes?.find(
    (route) => route.method === method && route.path === path,
  );
  assert.ok(route);
  return route.handler as unknown as Handler;
}

void test("inbox API paginates retained reports, authorizes access, and passes report/history into its own Iva session", async () => {
  const original = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), "iva-report-routes-"));
  process.env.ASSISTANT_DATA_DIR = directory;
  process.env.ASSISTANT_VAULT_DIR = join(directory, "vault");
  process.env.LIBRECHAT_NOTIFICATION_SECRET = "test-secret";
  process.env.LIBRECHAT_NOTIFICATION_USERS = "ceo@example.com";
  const request = (
    path: string,
    message?: string,
    email = "ceo@example.com",
  ) => {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", "test-secret")
      .update(`${timestamp}\0ceo\0${email}`)
      .digest("hex");
    return new Request(`http://localhost${path}`, {
      method: message === undefined ? "GET" : "POST",
      headers: {
        "x-librechat-user-id": "ceo",
        "x-librechat-user-email": email,
        "x-iva-notification-timestamp": timestamp,
        "x-iva-notification-signature": signature,
      },
      ...(message === undefined ? {} : { body: JSON.stringify({ message }) }),
    });
  };
  try {
    const old = Array.from({ length: 501 }, (_, index) => ({
      id: `old-${index}`,
      body: "archived",
      title: "old",
      kind: "report",
      createdAt: new Date(index).toISOString(),
    }));
    await writeFile(
      join(directory, "notifications.json"),
      JSON.stringify({ version: 1, notifications: old }),
    );
    const report = await createNotification({
      body: "Продажи упали. План: проверить причины.",
      kind: "report",
    });
    assert.ok(await getNotification("old-0"));
    assert.equal((await listNotifications(100, 500)).length, 2);
    const list = await handler("GET", "/iva/notifications")(
      request("/iva/notifications"),
      {},
    );
    const page = (await list.json()) as {
      notifications: unknown[];
      hasMore: boolean;
      unread: number;
    };
    assert.equal(page.notifications.length, 50);
    assert.equal(page.unread, 502);
    assert.ok(page.hasMore);
    const detail = handler("GET", "/iva/notifications/:id");
    assert.equal(
      (
        await detail(
          request("/iva/notifications/id", undefined, "outsider@example.com"),
          { params: { id: report.id } },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await detail(request("/iva/notifications/id"), {
          params: { id: "missing" },
        })
      ).status,
      404,
    );
    const messages = handler("POST", "/iva/notifications/:id/messages");
    let prompt = "";
    let token = "";
    const context = {
      params: { id: report.id },
      resolveActiveSession: async () => null,
      send: async (text: string, options: { continuationToken: string }) => {
        prompt = text;
        token = options.continuationToken;
        return {
          getEventStream: async () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "message.completed",
                  data: { message: "Проверим воронку." },
                });
                controller.enqueue({ type: "session.waiting", data: {} });
                controller.close();
              },
            }),
        };
      },
    };
    assert.equal(
      (
        await messages(
          request("/iva/notifications/id/messages", "Почему?"),
          context,
        )
      ).status,
      200,
    );
    assert.match(prompt, /Продажи упали/u);
    assert.match(prompt, /Почему/u);
    assert.match(token, /^report:/u);
    assert.equal(
      (
        await messages(
          request("/iva/notifications/id/messages", "Что дальше?"),
          context,
        )
      ).status,
      200,
    );
    assert.match(prompt, /Проверим воронку/u);
    const saved = (await (
      await detail(request("/iva/notifications/id"), {
        params: { id: report.id },
      })
    ).json()) as { messages: unknown[] };
    assert.equal(saved.messages.length, 4);
  } finally {
    for (const name of [
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_VAULT_DIR",
      "LIBRECHAT_NOTIFICATION_SECRET",
      "LIBRECHAT_NOTIFICATION_USERS",
    ]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
