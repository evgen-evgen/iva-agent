import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { notificationClientScript } from "./notification-client.ts";

void test("LibreChat notification client uses the durable inbox without assuming browser notification support", () => {
  assert.doesNotThrow(() => new Script(notificationClientScript));
  assert.match(notificationClientScript, /\/api\/iva\/notifications/u);
  assert.match(notificationClientScript, /tokenUpdated/u);
  assert.match(notificationClientScript, /Authorization: authorization/u);
  assert.match(notificationClientScript, /\/read-all/u);
  assert.match(notificationClientScript, /'Notification' in window/u);
  assert.match(
    notificationClientScript,
    /setInterval\(\(\) => void refresh\(\), 15000\)/u,
  );
  assert.match(
    notificationClientScript,
    /textContent = expandedBodies\.get\(item\.id\) \|\| item\.body/u,
  );
  assert.doesNotMatch(notificationClientScript, /innerHTML = item\./u);
});

void test("inbox recovers a session when loaded after login and exposes denied access instead of silently disappearing", async () => {
  const { runInNewContext } = await import("node:vm");
  const elements = new Map<string, FakeElement>();
  class FakeElement {
    id = "";
    textContent = "";
    innerHTML = "";
    hidden = false;
    disabled = false;
    type = "";
    title = "";
    className = "";
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    children: FakeElement[] = [];
    selectors = new Map<string, FakeElement>();
    listeners = new Map<string, () => unknown>();
    setAttribute() {}
    append(...nodes: FakeElement[]) {
      this.children.push(...nodes);
    }
    appendChild(node: FakeElement) {
      this.children.push(node);
      return node;
    }
    replaceChildren(...nodes: FakeElement[]) {
      this.children = nodes;
    }
    addEventListener(event: string, callback: () => unknown) {
      this.listeners.set(event, callback);
    }
    querySelector(selector: string) {
      if (selector.startsWith('[data-id="'))
        return this.children.find(
          (child) => child.dataset.id === selector.slice(10, -2),
        )!;
      if (selector.startsWith(".")) {
        const child = this.children.find(
          (node) => node.className === selector.slice(1),
        );
        if (child) return child;
      }
      if (!this.selectors.has(selector)) {
        const element = new FakeElement();
        this.selectors.set(selector, element);
        elements.set(selector, element);
      }
      return this.selectors.get(selector)!;
    }
  }
  const body = new FakeElement();
  const timeouts: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const requests: { url: string; authorization: string | undefined }[] = [];
  let denied = false;
  const destinations: string[] = [];
  const context: Record<string, unknown> = {
    document: {
      head: new FakeElement(),
      body,
      createElement: () => new FakeElement(),
      addEventListener: () => {},
    },
    location: {
      origin: "https://libre.test",
      href: "https://libre.test/",
      assign: (path: string) => destinations.push(path),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: () => {} },
    URL,
    Headers,
    Request,
    Intl,
    Date,
    XMLHttpRequest: class {
      static prototypeUnused = true;
      open() {}
      setRequestHeader() {}
    },
    console: { warn: () => {} },
    addEventListener: () => {},
    setTimeout: (callback: () => void) => timeouts.push(callback),
    setInterval: (callback: () => void) => intervals.push(callback),
    fetch: (input: string, options?: { headers?: Record<string, string> }) => {
      requests.push({
        url: input,
        authorization: options?.headers?.Authorization,
      });
      return Promise.resolve(
        input.endsWith("/api/auth/refresh")
          ? new Response(JSON.stringify({ token: "late-session" }))
          : denied
            ? new Response("{}", { status: 403 })
            : input.endsWith("/chat")
              ? new Response(JSON.stringify({ conversationId: "native-chat" }))
              : input.endsWith("/read")
                ? new Response("{}")
                : input.endsWith("/reminder")
                  ? new Response(
                      JSON.stringify({
                        notification: { body: "Полный текст напоминания" },
                      }),
                    )
                  : new Response(
                      JSON.stringify({
                        notifications: [
                          {
                            id: "report",
                            kind: "report",
                            title: "Готовый отчёт",
                            body: "Результат",
                            createdAt: new Date().toISOString(),
                          },
                          {
                            id: "reminder",
                            kind: "reminder",
                            title: "Напоминание",
                            body: "Короткий текст",
                            readAt: "2026-10-04",
                            createdAt: new Date().toISOString(),
                          },
                        ],
                        unread: 1,
                        hasMore: false,
                      }),
                    ),
      );
    },
  };
  context.window = context;
  runInNewContext(notificationClientScript, context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await settle();
  timeouts[0]();
  await settle();
  assert.ok(
    requests.some(
      (r) =>
        r.url.endsWith("/api/iva/notifications") &&
        r.authorization === "Bearer late-session",
    ),
  );
  assert.equal(elements.get("#iva-notification-badge")?.textContent, "1");
  const notificationList = elements.get("#iva-notification-list")!;
  await notificationList.children[0].listeners.get("click")!();
  await settle();
  assert.deepEqual(destinations, ["/c/native-chat"]);
  assert.ok(
    !body.children.some((element) => element.id === "iva-report-reader"),
  );
  await notificationList.children[1].listeners.get("click")!();
  await settle();
  intervals[0]();
  await settle();
  assert.equal(
    notificationList.children[1].querySelector(".iva-notification-body")
      .textContent,
    "Полный текст напоминания",
  );
  assert.equal(destinations.length, 1);
  denied = true;
  intervals[0]();
  await settle();
  const failure = elements.get("#iva-notification-list")?.children[0];
  assert.match(
    failure?.textContent ?? "",
    /учётной записи входящие Ивы не разрешены/u,
  );
});
