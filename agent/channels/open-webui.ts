import { defineChannel, GET, POST, type Session } from "eve/channels";
import {
  inboundTruncationNotice,
  injectionWarning,
} from "../lib/telegram-gate-notice.js";
import { redactNotice } from "../lib/outbox.js";
import {
  authorizedOpenWebUiRequest,
  openAiCompletion,
  openAiCompletionStream,
  openWebUiAgentMessage,
  openWebUiContinuation,
  openWebUiIdentity,
  parseOpenAiChatRequest,
} from "../lib/open-webui.js";
import { openWebUiAttachments } from "../lib/open-webui-media.js";
import { sanitizeInbound } from "../lib/security-gate.js";
import { appendDaily } from "../lib/vault-daily.js";
import { transcribe } from "../transcribe.js";

type StreamEvent = {
  readonly type?: unknown;
  readonly data?: unknown;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openAiError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code: null } },
    { status, headers: jsonHeaders },
  );
}

function requireAdapterAuth(request: Request): Response | null {
  if (authorizedOpenWebUiRequest(request)) return null;
  return openAiError("invalid API key", 401);
}

function webAuth(identity: ReturnType<typeof openWebUiIdentity>) {
  return {
    attributes: {
      chat_id: identity.chatId,
      ...(identity.userName ? { user_name: identity.userName } : {}),
    },
    authenticator: "open-webui-bearer",
    issuer: "open-webui",
    principalId: identity.userId,
    principalType: "user",
  } as const;
}

function inbound(prompt: string): { message: string; context?: string[] } {
  const dailyPath = appendDaily("[text]", prompt);
  const sanitized = sanitizeInbound(prompt);
  const flagged = sanitized.blocked || sanitized.flags.length > 0;
  const truncation = inboundTruncationNotice(sanitized, dailyPath);
  if (!flagged && !truncation) return { message: prompt };
  if (flagged) {
    console.error(
      "[security] Open WebUI inbound flagged:",
      sanitized.reason,
      sanitized.flags.join(","),
    );
  }
  return {
    message: prompt,
    context: [
      ...(sanitized.blocked ? [injectionWarning()] : []),
      sanitized.text,
      ...(truncation ? [truncation] : []),
    ],
  };
}

async function completedMessage(
  session: Session,
  startIndex: number,
): Promise<string> {
  const stream = await session.getEventStream({ startIndex });
  const reader = stream.getReader();
  let answer = "";
  let failure = "";

  const inspect = (event: StreamEvent): boolean => {
    const data = isRecord(event.data) ? event.data : {};
    if (
      event.type === "message.completed" &&
      data.finishReason !== "tool-calls" &&
      typeof data.message === "string"
    ) {
      answer = data.message;
    }
    if (
      (event.type === "turn.failed" || event.type === "session.failed") &&
      typeof data.message === "string"
    ) {
      failure = data.message;
    }
    return (
      event.type === "session.waiting" ||
      event.type === "session.completed" ||
      event.type === "session.failed"
    );
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (inspect(value)) {
        if (failure) throw new Error(failure);
        if (!answer) throw new Error("the agent completed without a message");
        return answer;
      }
    }
    throw new Error(failure || "the agent event stream ended unexpectedly");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export default defineChannel({
  routes: [
    GET("/v1/models", async (request) => {
      const denied = requireAdapterAuth(request);
      if (denied) return denied;
      return Response.json({
        object: "list",
        data: [{ id: "iva", object: "model", created: 0, owned_by: "iva" }],
      });
    }),
    POST("/v1/audio/transcriptions", async (request) => {
      const denied = requireAdapterAuth(request);
      if (denied) return denied;
      try {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof Blob) || file.size === 0) {
          return openAiError("a non-empty audio file is required", 400);
        }
        if (file.size > 20 * 1024 * 1024) {
          return openAiError("audio file is larger than 20 MB", 413);
        }
        const text = (await transcribe(await file.arrayBuffer())).trim();
        if (!text) return openAiError("audio transcription was empty", 422);
        return Response.json({ text }, { headers: jsonHeaders });
      } catch (error) {
        console.error("[open-webui] speech transcription failed:", error);
        return openAiError("audio transcription failed", 502);
      }
    }),
    POST(
      "/v1/chat/completions",
      async (request, { getSession, resolveActiveSession, send }) => {
        const denied = requireAdapterAuth(request);
        if (denied) return denied;

        let parsed: ReturnType<typeof parseOpenAiChatRequest>;
        let identity: ReturnType<typeof openWebUiIdentity>;
        try {
          parsed = parseOpenAiChatRequest(await request.json());
          identity = openWebUiIdentity(request.headers);
        } catch (error) {
          return openAiError(
            error instanceof Error ? error.message : "invalid request",
            400,
          );
        }
        if (parsed.model !== "iva") return openAiError("model not found", 404);

        const continuationToken = openWebUiContinuation(identity);
        const active = await resolveActiveSession({ continuationToken });
        const startIndex = active
          ? (await getSession(active.sessionId).getStreamTailIndex()) + 1
          : 0;
        const prepared = inbound(parsed.prompt);
        try {
          const attachmentContext = await openWebUiAttachments(parsed.attachments);
          const session = await send(
            openWebUiAgentMessage(prepared.message, [
              ...(prepared.context ?? []),
              ...attachmentContext,
            ]),
            {
              auth: webAuth(identity),
              continuationToken,
            },
          );
          const message = redactNotice(
            await completedMessage(session, startIndex),
          );
          if (parsed.stream) {
            return new Response(openAiCompletionStream(message), {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
              },
            });
          }
          return Response.json(openAiCompletion(message));
        } catch (error) {
          console.error("[open-webui] completion failed:", error);
          return openAiError("agent request failed", 502);
        }
      },
    ),
  ],
});
