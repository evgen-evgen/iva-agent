import { defineChannel, GET, POST, type Session } from "eve/channels";
import {
  inboundTruncationNotice,
  injectionWarning,
} from "../lib/telegram-gate-notice.js";
import { redactNotice } from "../lib/outbox.js";
import {
  authorizedOpenWebUiRequest,
  libreChatTitle,
  openAiCompletion,
  openAiStreamChunk,
  openAiStreamDone,
  openAiStreamPieces,
  openAiStreamState,
  openWebUiAgentMessage,
  openWebUiContinuation,
  openWebUiIdentity,
  parseOpenAiChatRequest,
} from "../lib/open-webui.js";
import { openWebUiAttachments } from "../lib/open-webui-media.js";
import { notificationClientScript } from "../lib/notification-client.js";
import {
  listNotifications,
  markNotificationRead,
} from "../lib/notification-store.js";
import { sanitizeInbound } from "../lib/security-gate.js";
import { appendDaily, localStamp, saveBlob } from "../lib/vault-daily.js";
import { transcribe } from "../transcribe.js";

type StreamEvent = {
  readonly type?: unknown;
  readonly data?: unknown;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function allowedNotificationOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const port = process.env.LIBRECHAT_PORT?.trim() || "3080";
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

function denyNotificationOrigin(): Response {
  return Response.json({ error: "forbidden origin" }, { status: 403 });
}

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

function liveCompletionStream(
  session: Session,
  startIndex: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const state = openAiStreamState();
  let reader: ReadableStreamDefaultReader<StreamEvent> | undefined;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (value: string) =>
        controller.enqueue(encoder.encode(value));
      const writeText = async (value: string) => {
        const pieces = openAiStreamPieces(redactNotice(value));
        for (const [index, piece] of pieces.entries()) {
          if (closed) return;
          write(openAiStreamChunk(state, piece));
          if (pieces.length > 1 && index < pieces.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 24));
          }
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        write(openAiStreamChunk(state, "", { finishReason: "stop" }));
        write(openAiStreamDone());
        controller.close();
      };
      const fail = () => {
        if (closed) return;
        closed = true;
        write(
          `data: ${JSON.stringify({
            error: {
              message: "Iva could not complete this request",
              type: "server_error",
            },
          })}\n\n`,
        );
        write(openAiStreamDone());
        controller.close();
      };

      void (async () => {
        const stream = await session.getEventStream({ startIndex });
        reader = stream.getReader();
        const streamedSteps = new Set<number>();
        write(openAiStreamChunk(state, "", { role: true }));

        for (;;) {
          const { done, value: event } = await reader.read();
          if (done) {
            fail();
            return;
          }
          const data = isRecord(event.data) ? event.data : {};
          if (
            event.type === "message.appended" &&
            typeof data.messageDelta === "string"
          ) {
            if (typeof data.stepIndex === "number")
              streamedSteps.add(data.stepIndex);
            await writeText(data.messageDelta);
            continue;
          }
          if (
            event.type === "message.completed" &&
            data.finishReason !== "tool-calls" &&
            typeof data.message === "string" &&
            (typeof data.stepIndex !== "number" ||
              !streamedSteps.has(data.stepIndex))
          ) {
            await writeText(data.message);
            continue;
          }
          if (event.type === "turn.failed" || event.type === "session.failed") {
            fail();
            return;
          }
          if (
            event.type === "session.waiting" ||
            event.type === "session.completed"
          ) {
            finish();
            return;
          }
        }
      })().catch((error: unknown) => {
        console.error("[open-webui] completion stream failed:", error);
        fail();
      });
    },
    async cancel() {
      closed = true;
      await reader?.cancel().catch(() => {});
      await session.cancel().catch(() => {});
    },
  });

  return body;
}

export default defineChannel({
  // Notification API requests are additionally restricted to the configured
  // loopback LibreChat origin. `cors: true` lets Eve answer browser preflights.
  cors: true,
  routes: [
    GET("/iva/notifications/client.js", () =>
      Promise.resolve(
        new Response(notificationClientScript, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
          },
        }),
      ),
    ),
    GET("/iva/notifications", async (request) => {
      if (!allowedNotificationOrigin(request)) return denyNotificationOrigin();
      try {
        const notifications = (await listNotifications()).map((item) => ({
          ...item,
          body: redactNotice(item.body),
          title: redactNotice(item.title),
        }));
        return Response.json(
          {
            notifications,
            unread: notifications.filter((item) => !item.readAt).length,
          },
          { headers: { ...jsonHeaders, "cache-control": "no-store" } },
        );
      } catch (error) {
        console.error("[notifications] list failed:", error);
        return Response.json(
          { error: "notification inbox unavailable" },
          { status: 500 },
        );
      }
    }),
    POST("/iva/notifications/read-all", async (request) => {
      if (!allowedNotificationOrigin(request)) return denyNotificationOrigin();
      try {
        return Response.json({ changed: await markNotificationRead() });
      } catch (error) {
        console.error("[notifications] acknowledge all failed:", error);
        return Response.json(
          { error: "notification inbox unavailable" },
          { status: 500 },
        );
      }
    }),
    POST("/iva/notifications/:id/read", async (request, { params }) => {
      if (!allowedNotificationOrigin(request)) return denyNotificationOrigin();
      try {
        return Response.json({
          changed: await markNotificationRead(params.id),
        });
      } catch (error) {
        console.error("[notifications] acknowledge failed:", error);
        return Response.json(
          { error: "notification inbox unavailable" },
          { status: 500 },
        );
      }
    }),
    GET("/v1/models", (request) => {
      const denied = requireAdapterAuth(request);
      if (denied) return Promise.resolve(denied);
      return Promise.resolve(
        Response.json({
          object: "list",
          data: [{ id: "iva", object: "model", created: 0, owned_by: "iva" }],
        }),
      );
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
        const audio = await file.arrayBuffer();
        const mediaType = file.type || undefined;
        const text = (await transcribe(audio, mediaType)).trim();
        if (!text) {
          const saved = saveBlob(
            audio,
            file instanceof File ? file.name : undefined,
            "voice",
            mediaType,
            localStamp(),
          );
          console.error("[open-webui] empty speech transcript:", {
            bytes: audio.byteLength,
            mediaType: mediaType ?? "unknown",
            saved,
          });
          return openAiError("audio transcription was empty", 422);
        }
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

        const title = libreChatTitle(parsed.prompt);
        if (title !== null) {
          return Response.json(openAiCompletion(title));
        }

        const continuationToken = openWebUiContinuation(identity);
        const active = await resolveActiveSession({ continuationToken });
        const startIndex = active
          ? (await getSession(active.sessionId).getStreamTailIndex()) + 1
          : 0;
        const prepared = inbound(parsed.prompt);
        try {
          const attachmentContext = await openWebUiAttachments(
            parsed.attachments,
          );
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
          if (parsed.stream) {
            return new Response(liveCompletionStream(session, startIndex), {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                "x-accel-buffering": "no",
              },
            });
          }
          const message = redactNotice(
            await completedMessage(session, startIndex),
          );
          return Response.json(openAiCompletion(message));
        } catch (error) {
          console.error("[open-webui] completion failed:", error);
          return openAiError("agent request failed", 502);
        }
      },
    ),
  ],
});
