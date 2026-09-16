import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

type OpenAiTextPart = {
  readonly type?: unknown;
  readonly text?: unknown;
};

export type OpenAiMessage = {
  readonly role?: unknown;
  readonly content?: unknown;
};

export type OpenAiChatRequest = {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
};

export type OpenWebUiIdentity = {
  readonly chatId: string;
  readonly userId: string;
  readonly userName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (!isRecord(part)) return "";
      const typed = part as OpenAiTextPart;
      return typed.type === "text" && typeof typed.text === "string"
        ? typed.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
  return text || null;
}

export function parseOpenAiChatRequest(value: unknown): {
  model: string;
  prompt: string;
  stream: boolean;
} {
  if (!isRecord(value)) throw new Error("request body must be an object");
  const body = value as OpenAiChatRequest;
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new Error("model is required");
  }
  if (!Array.isArray(body.messages)) throw new Error("messages are required");
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const prompt = textContent(message.content)?.trim();
    if (prompt) {
      return { model: body.model, prompt, stream: body.stream === true };
    }
  }
  throw new Error("a non-empty user message is required");
}

export function openWebUiIdentity(headers: Headers): OpenWebUiIdentity {
  const chatId = headers.get("x-openwebui-chat-id")?.trim();
  const userId = headers.get("x-openwebui-user-id")?.trim();
  if (!chatId || !userId) {
    throw new Error(
      "Open WebUI identity headers are required; enable ENABLE_FORWARD_USER_INFO_HEADERS",
    );
  }
  const userName = headers.get("x-openwebui-user-name")?.trim() || undefined;
  return { chatId, userId, ...(userName ? { userName } : {}) };
}

export function openWebUiContinuation(identity: OpenWebUiIdentity): string {
  return createHash("sha256")
    .update(`${identity.userId}\0${identity.chatId}`)
    .digest("base64url");
}

export function authorizedOpenWebUiRequest(
  request: Request,
  expectedSecret = process.env.OPEN_WEBUI_API_KEY,
): boolean {
  const expected = expectedSecret?.trim();
  const header = request.headers.get("authorization") ?? "";
  const received = /^Bearer\s+(.+)$/iu.exec(header)?.[1]?.trim();
  if (!expected || !received) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(received).digest();
  return timingSafeEqual(left, right);
}

export function openAiCompletion(message: string, model = "iva") {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: message },
        finish_reason: "stop",
      },
    ],
  };
}

export function openAiCompletionStream(message: string, model = "iva"): string {
  const completion = openAiCompletion(message, model);
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model,
    choices: [
      { index: 0, delta: { role: "assistant", content: message }, finish_reason: null },
    ],
  };
  const done = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
}
