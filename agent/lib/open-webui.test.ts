import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedOpenWebUiRequest,
  openAiCompletionStream,
  openWebUiContinuation,
  openWebUiIdentity,
  parseOpenAiChatRequest,
} from "./open-webui.ts";

test("extracts only the latest user text from an OpenAI chat request", () => {
  assert.deepEqual(
    parseOpenAiChatRequest({
      model: "iva",
      stream: true,
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "new" },
            { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
          ],
        },
      ],
    }),
    { model: "iva", prompt: "new", stream: true },
  );
});

test("requires forwarded Open WebUI conversation identity", () => {
  const headers = new Headers({
    "x-openwebui-chat-id": "chat-a",
    "x-openwebui-user-id": "user-a",
    "x-openwebui-user-name": "Ada",
  });
  assert.deepEqual(openWebUiIdentity(headers), {
    chatId: "chat-a",
    userId: "user-a",
    userName: "Ada",
  });
  assert.equal(openWebUiContinuation(openWebUiIdentity(headers)).length, 43);
  assert.throws(() => openWebUiIdentity(new Headers()), /identity headers/u);
});

test("authenticates the adapter with a dedicated bearer", () => {
  const request = new Request("http://iva.test/v1/models", {
    headers: { authorization: "Bearer bridge-secret" },
  });
  assert.equal(authorizedOpenWebUiRequest(request, "bridge-secret"), true);
  assert.equal(authorizedOpenWebUiRequest(request, "other"), false);
  assert.equal(authorizedOpenWebUiRequest(request, ""), false);
});

test("emits a complete OpenAI-compatible SSE response", () => {
  const stream = openAiCompletionStream("hello");
  assert.match(stream, /chat\.completion\.chunk/u);
  assert.match(stream, /"content":"hello"/u);
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
});

