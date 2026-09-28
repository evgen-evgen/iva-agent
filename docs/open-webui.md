# Open WebUI

Open WebUI is an optional browser surface for Iva. It does not call the configured model
provider directly: its OpenAI-compatible request goes to Iva, and Iva starts or resumes the
same Eve agent runtime that owns the vault, memory, tools, skills, and model configuration.

For the alternative LibreChat frontend, see [LibreChat](./librechat.md).

## Architecture

```text
browser -> Open WebUI -> /v1/chat/completions -> open-webui channel -> Eve agent
                                      |                               |
                                      |                               +-> vault/tools/model
                                      +-> OpenAI response <- outbound gate

Telegram -> long-poll bridge -> telegram channel --------------------+
```

The two channels are independent. Telegram can stay enabled during migration; it does not
proxy Open WebUI and Open WebUI does not emulate a Telegram update.

The compose service uses host networking deliberately. Both Eve and Open WebUI remain bound
to `127.0.0.1`, so the container can reach Eve without changing Eve's production loopback
binding or publishing its privileged session API on the LAN.

Open WebUI's automatic title, tag, follow-up, query, and autocomplete generations are disabled
in compose. By default they reuse the chat model; with a stateful agent that would turn UI
housekeeping into real Iva turns and write it into the vault. They can later use a separate
cheap stateless task model instead.

## Start

Add two different random secrets to `.env`:

```dotenv
OPEN_WEBUI_SECRET_KEY=<random secret used to sign WebUI sessions>
OPEN_WEBUI_API_KEY=<random bearer used only between Open WebUI and Iva>
```

For a browser-only installation, disable Telegram explicitly:

```dotenv
TELEGRAM_ENABLED=false
```

This makes `npm run poll` exit successfully without contacting Telegram and makes the
Telegram credentials optional in `iva doctor`. It does not delete them, so the channel can
be restored later with `TELEGRAM_ENABLED=true`.

Build and restart Iva so the authored channel is present, then start the UI:

```bash
npm run build
npm run start:ui
docker compose up -d
```

`npm run start:ui` loads `.env`, maps `IVA_PORT` to Eve's runtime `PORT`, and binds only to
`127.0.0.1`. Keep that terminal open; stop it with Ctrl+C.

Open `http://127.0.0.1:3000`, create the first (admin) account, and select the `iva` model.
On a remote VPS, keep the service private and use an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 user@server
```

The compose file pins Open WebUI rather than tracking `main`. Its named volume contains the
account, chats, and UI settings; removing that volume deletes them.

## Current boundary

The bridge supports linear chats with text and attachments:

- `X-OpenWebUI-User-Id` plus `X-OpenWebUI-Chat-Id` select a durable Eve conversation.
- Only the latest user message is sent because Eve already owns the conversation history.
- User text is written to the daily transcript and passes Iva's inbound gate.
- Images, documents, and audio are saved under `vault/attachments/`. Images go to the
  chat model when it supports vision and otherwise through Iva's configured vision model;
  uploaded audio uses the same Deepgram transcription path as Telegram.
- The complete assistant message passes the outbound secret gate before it is returned.
- OpenAI SSE is syntactically supported, but the answer is released as one buffered chunk.
  Buffering is intentional: sending raw token deltas would let a secret escape before the
  complete outbound scanner can recognize and redact it.

Not yet supported: Open WebUI chat branches or editing an earlier message, interactive HITL
cards, and propagating the browser Stop action to Eve cancellation. Keep the Telegram surface
available for those flows until they are implemented and acceptance-tested.
