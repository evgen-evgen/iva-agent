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
export const LIBRECHAT_TITLE_MARKER = "__IVA_LIBRECHAT_TITLE__";

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
      if (!isRecord(part.input_audio))
        throw new Error("input_audio is invalid");
      const format = part.input_audio.format;
      if (typeof format !== "string")
        throw new Error("audio format is required");
      attachments.push({
        bytes: decodeBase64(String(part.input_audio.data ?? "")),
        filename: `voice.${format.toLowerCase()}`,
        kind: "audio",
        mediaType: audioMediaType(format),
      });
      continue;
    }
    if (part.type === "file" || part.type === "input_file") {
      const file =
        part.type === "file" && isRecord(part.file) ? part.file : part;
      const decoded = dataUrl(file.file_data);
      attachments.push({
        ...decoded,
        ...(typeof file.filename === "string"
          ? { filename: file.filename }
          : {}),
        kind: decoded.mediaType.startsWith("audio/")
          ? "audio"
          : decoded.mediaType.startsWith("image/")
            ? "image"
            : "file",
      });
    }
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(
      `too many attachments: ${attachments.length} > ${MAX_ATTACHMENTS}`,
    );
  }
  const total = attachments.reduce(
    (sum, attachment) => sum + attachment.bytes.byteLength,
    0,
  );
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
 * LibreChat normally asks the selected model to name a new conversation.
 * The marker lets the HTTP channel answer that service request locally, so it
 * never becomes a user turn in Iva's session or vault.
 */
export function libreChatTitle(prompt: string): string | null {
  if (!prompt.startsWith(LIBRECHAT_TITLE_MARKER)) return null;

  const conversation = prompt.slice(LIBRECHAT_TITLE_MARKER.length).trim();
  const userMatch = /(?:^|\n)User:\s*([\s\S]*?)(?=\nAI:|$)/u.exec(conversation);
  const question = (userMatch?.[1] ?? conversation)
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/[`*_#[\](){}<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = question.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  if (words.length === 0) return "Новый чат";

  let title = words.slice(0, 6).join(" ");
  if (title.length > 60) title = `${title.slice(0, 57).trimEnd()}…`;
  return title[0].toLocaleUpperCase("ru-RU") + title.slice(1);
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

export type OpenAiStreamState = {
  readonly created: number;
  readonly id: string;
  readonly model: string;
};

export function openAiStreamState(model = "iva"): OpenAiStreamState {
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

export function openAiStreamChunk(
  state: OpenAiStreamState,
  message: string,
  options: {
    readonly finishReason?: "stop" | null;
    readonly role?: boolean;
  } = {},
): string {
  const delta: { content?: string; role?: "assistant" } = {};
  if (options.role) delta.role = "assistant";
  if (message) delta.content = message;
  return `data: ${JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
      },
    ],
  })}\n\n`;
}

export function openAiStreamDone(): string {
  return "data: [DONE]\n\n";
}

/**
 * Eve may durably coalesce adjacent model deltas into one event. Split a large
 * coalesced event for browser rendering while preserving the exact text.
 * Small provider deltas pass through unchanged and keep their natural cadence.
 */
export function openAiStreamPieces(text: string, limit = 32): string[] {
  if (!text || text.length <= limit) return text ? [text] : [];
  const characters = Array.from(text);
  const pieces: string[] = [];
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + limit, characters.length);
    if (end < characters.length) {
      const minimum = start + Math.floor(limit / 2);
      for (let cursor = end; cursor > minimum; cursor--) {
        if (/\s/u.test(characters[cursor - 1] ?? "")) {
          end = cursor;
          break;
        }
      }
    }
    pieces.push(characters.slice(start, end).join(""));
    start = end;
  }
  return pieces;
}

export function openAiCompletionStream(message: string, model = "iva"): string {
  const state = openAiStreamState(model);
  return (
    openAiStreamChunk(state, message, { role: true }) +
    openAiStreamChunk(state, "", { finishReason: "stop" }) +
    openAiStreamDone()
  );
}
