import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { notificationClientScript } from "./notification-client.ts";

void test("LibreChat notification client uses the durable inbox without assuming browser notification support", () => {
  assert.doesNotThrow(() => new Script(notificationClientScript));
  assert.match(notificationClientScript, /\/iva\/notifications/u);
  assert.match(notificationClientScript, /\/read-all/u);
  assert.match(notificationClientScript, /'Notification' in window/u);
  assert.match(
    notificationClientScript,
    /setInterval\(\(\) => void refresh\(\), 15000\)/u,
  );
  assert.match(notificationClientScript, /textContent = item\.body/u);
  assert.doesNotMatch(notificationClientScript, /innerHTML = item\./u);
});
