import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

type OpenAiTextPart = {
  readonly type?: unknown;
  readonly text?: unknown;
};

export type OpenAiAttachment = {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly kind: "audio" | "file" | "image";
  readonly mediaType: string;
};

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

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

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/gu, "");
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    throw new Error("attachment contains invalid base64 data");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment is larger than 20 MB");
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function dataUrl(value: unknown): { bytes: Uint8Array; mediaType: string } {
  if (typeof value !== "string") throw new Error("attachment data is required");
  const match = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(value);
  if (!match) throw new Error("only inline base64 attachments are supported");
  return { mediaType: match[1].toLowerCase(), bytes: decodeBase64(match[2]) };
}

function audioMediaType(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "mp3" || normalized === "mpeg") return "audio/mpeg";
  if (normalized === "m4a" || normalized === "mp4") return "audio/mp4";
  if (normalized === "wav" || normalized === "wave") return "audio/wav";
  if (normalized === "oga" || normalized === "ogg") return "audio/ogg";
  if (normalized === "webm") return "audio/webm";
  if (normalized === "flac") return "audio/flac";
  throw new Error(`unsupported audio format: ${format}`);
}

function messageContent(content: unknown): {
  attachments: OpenAiAttachment[];
  text: string;
} {
  if (typeof content === "string") return { attachments: [], text: content };
  if (!Array.isArray(content)) return { attachments: [], text: "" };
  const attachments: OpenAiAttachment[] = [];
  const texts: string[] = [];
  for (const value of content) {
    if (!isRecord(value)) continue;
    const part = value as OpenAiTextPart & Record<string, unknown>;
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      if (part.text) texts.push(part.text);
      continue;
    }
    if (part.type === "image_url") {
      if (!isRecord(part.image_url)) throw new Error("image_url is invalid");
      const decoded = dataUrl(part.image_url.url);
      if (!decoded.mediaType.startsWith("image/")) {
        throw new Error("image_url must contain an image");
      }
      attachments.push({ ...decoded, kind: "image" });
      continue;
    }
    if (part.type === "input_audio") {
      if (!isRecord(part.input_audio)) throw new Error("input_audio is invalid");
      const format = part.input_audio.format;
      if (typeof format !== "string") throw new Error("audio format is required");
      attachments.push({
        bytes: decodeBase64(String(part.input_audio.data ?? "")),
        filename: `voice.${format.toLowerCase()}`,
        kind: "audio",
        mediaType: audioMediaType(format),
      });
      continue;
    }
    if (part.type === "file" || part.type === "input_file") {
      const file = part.type === "file" && isRecord(part.file) ? part.file : part;
      const decoded = dataUrl(file.file_data);
      attachments.push({
        ...decoded,
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
        kind: decoded.mediaType.startsWith("audio/")
          ? "audio"
          : decoded.mediaType.startsWith("image/")
            ? "image"
            : "file",
      });
    }
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`too many attachments: ${attachments.length} > ${MAX_ATTACHMENTS}`);
  }
  const total = attachments.reduce((sum, attachment) => sum + attachment.bytes.byteLength, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("attachments are larger than 25 MB in total");
  }
  return { attachments, text: texts.join("\n") };
}

export function parseOpenAiChatRequest(value: unknown): {
  attachments: OpenAiAttachment[];
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
    const content = messageContent(message.content);
    const prompt = content.text.trim();
    if (prompt || content.attachments.length > 0) {
      return {
        attachments: content.attachments,
        model: body.model,
        prompt: prompt || "Пользователь отправил вложение без подписи.",
        stream: body.stream === true,
      };
    }
  }
  throw new Error("a non-empty user message is required");
}

/**
 * Custom-channel `send()` accepts one model message and has no Telegram-style
 * `context` option. Put bridge context into that message explicitly so saved
 * attachment paths, transcripts, and vision descriptions reach Iva.
 */
export function openWebUiAgentMessage(
  prompt: string,
  context: readonly string[],
): string {
  if (context.length === 0) return prompt;
  return (
    "Контекст текущего сообщения, подготовленный мостом:\n" +
    context.join("\n\n") +
    "\n\nСообщение пользователя:\n" +
    prompt
  );
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
