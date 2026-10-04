/* eslint-disable @typescript-eslint/require-await -- Synchronous network mocks implement Promise contracts. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";

void test("LibreChat proxy requires JWT identity, signs the account and forwards acknowledgements as JSON", async () => {
  type Request = {
    method: string;
    user?: { id: string; email: string };
    params: { id: string };
    body?: unknown;
    headers?: { authorization?: string };
  };
  type ResponseLike = {
    set: (key: string, value: string) => void;
    status: (code: number) => ResponseLike;
    send: (body: unknown) => void;
    json: (body: unknown) => void;
  };
  type Handler = (request: Request, response: ResponseLike) => Promise<void>;
  const routes = new Map<string, Handler>();
  const middleware: unknown[] = [];
  const requireJwtAuth = () => {};
  const router = {
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) =>
      routes.set(`POST ${path}`, handler),
    use: (handler: unknown) => middleware.push(handler),
  };
  const calls: {
    url: string;
    options: { method: string; headers: Record<string, string>; body: string };
  }[] = [];
  const source = await readFile(
    new URL("../../librechat/iva-notifications-route.js", import.meta.url),
    "utf8",
  );
  runInNewContext(source, {
    require: (name: string) =>
      name === "node:crypto"
        ? { createHmac, timingSafeEqual }
        : name === "express"
          ? { Router: () => router, json: () => "json-parser" }
          : { requireJwtAuth },
    process: {
      env: { LIBRECHAT_NOTIFICATION_SECRET: "secret", IVA_PORT: "8723" },
    },
    module: { exports: {} },
    Buffer,
    console,
    fetch: async (url: string, options: (typeof calls)[number]["options"]) => {
      calls.push({ url, options });
      return new Response("{}");
    },
  });
  assert.equal(middleware[0], requireJwtAuth);
  assert.equal(middleware[1], "json-parser");
  let status = 0;
  const response: ResponseLike = {
    set: () => {},
    status: (code) => {
      status = code;
      return response;
    },
    send: () => {},
    json: () => {},
  };
  const post = routes.get("POST /:id/read")!;
  await routes.get("POST /sync")!(
    { method: "POST", params: { id: "" }, headers: {} },
    response,
  );
  assert.equal(status, 401);
  assert.equal(calls.length, 0);
  await post(
    {
      method: "POST",
      params: { id: "report-id" },
      body: { message: "Почему?" },
    },
    response,
  );
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
  await post(
    {
      method: "POST",
      params: { id: "report-id" },
      user: { id: "ceo", email: "CEO@example.com" },
      body: { message: "Почему?" },
    },
    response,
  );
  assert.equal(status, 200);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:8723/iva/notifications/report-id/read",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: "Почему?" });
  const headers = calls[0].options.headers;
  assert.equal(headers["x-librechat-user-email"], "ceo@example.com");
  assert.equal(
    headers["x-iva-notification-signature"],
    createHmac("sha256", "secret")
      .update(
        `${headers["x-iva-notification-timestamp"]}\0ceo\0ceo@example.com`,
      )
      .digest("hex"),
  );
});
