import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedOpenWebUiRequest,
  libreChatTitle,
  openAiCompletionStream,
  openAiStreamChunk,
  openAiStreamDone,
  openAiStreamPieces,
  openWebUiAgentMessage,
  openWebUiContinuation,
  openWebUiIdentity,
  parseOpenAiChatRequest,
} from "./open-webui.ts";

test("creates LibreChat titles locally without treating ordinary prompts as titles", () => {
  assert.equal(
    libreChatTitle(
      "__IVA_LIBRECHAT_TITLE__\nUser: как связать Telegram и LibreChat с общей памятью?\nAI: Хорошо.",
    ),
    "Как связать Telegram и LibreChat с",
  );
  assert.equal(libreChatTitle("обычное сообщение"), null);
  assert.equal(
    libreChatTitle("__IVA_LIBRECHAT_TITLE__\nUser: ???\nAI:"),
    "Новый чат",
  );
});

test("puts attachment context into the actual custom-channel message", () => {
  assert.equal(openWebUiAgentMessage("что это?", []), "что это?");
  assert.equal(
    openWebUiAgentMessage("что это?", [
      "[image] изображение сохранено (vault/attachments/2026-09-20/image.png). Что на нём: лампа",
    ]),
    "Контекст текущего сообщения, подготовленный мостом:\n" +
      "[image] изображение сохранено (vault/attachments/2026-09-20/image.png). Что на нём: лампа\n\n" +
      "Сообщение пользователя:\nчто это?",
  );
});

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
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,xw==" },
            },
          ],
        },
      ],
    }),
    {
      attachments: [
        {
          bytes: new Uint8Array([199]),
          kind: "image",
          mediaType: "image/png",
        },
      ],
      model: "iva",
      prompt: "new",
      stream: true,
    },
  );
});

test("decodes LibreChat document and audio content parts", () => {
  const parsed = parseOpenAiChatRequest({
    model: "iva",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename: "notes.txt",
              file_data: "data:text/plain;base64,aGVsbG8=",
            },
          },
          {
            type: "input_audio",
            input_audio: { data: "UklGRg==", format: "wav" },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.prompt, "Пользователь отправил вложение без подписи.");
  assert.deepEqual(
    parsed.attachments.map(({ bytes, ...attachment }) => ({
      ...attachment,
      bytes: [...bytes],
    })),
    [
      {
        bytes: [104, 101, 108, 108, 111],
        filename: "notes.txt",
        kind: "file",
        mediaType: "text/plain",
      },
      {
        bytes: [82, 73, 70, 70],
        filename: "voice.wav",
        kind: "audio",
        mediaType: "audio/wav",
      },
    ],
  );
});

test("rejects remote and oversized attachment payloads instead of dropping them", () => {
  assert.throws(
    () =>
      parseOpenAiChatRequest({
        model: "iva",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.png" },
              },
            ],
          },
        ],
      }),
    /only inline base64/u,
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

test("emits incremental chunks with one completion id", () => {
  const state = { id: "chatcmpl-test", created: 1, model: "iva" };
  const stream =
    openAiStreamChunk(state, "", { role: true }) +
    openAiStreamChunk(state, "При") +
    openAiStreamChunk(state, "вет") +
    openAiStreamChunk(state, "", { finishReason: "stop" }) +
    openAiStreamDone();

  assert.equal(stream.match(/chatcmpl-test/gu)?.length, 4);
  assert.match(stream, /"content":"При"/u);
  assert.match(stream, /"content":"вет"/u);
  assert.match(stream, /"finish_reason":"stop"/u);
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
});

test("splits coalesced stream events without changing their text", () => {
  const text =
    "Первый длинный фрагмент ответа 🙂 и его продолжение без потерь.";
  const pieces = openAiStreamPieces(text, 16);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(""), text);
  assert.deepEqual(openAiStreamPieces("коротко", 16), ["коротко"]);
  assert.deepEqual(openAiStreamPieces("", 16), []);
});
