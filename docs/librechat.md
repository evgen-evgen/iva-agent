# LibreChat

LibreChat is an optional alternative browser UI for the same Iva runtime. It connects to
Iva's OpenAI-compatible `/v1` endpoint; models and tools still run inside Iva. LibreChat's
own agents, prompts, memory, MCP, skills, web search, file search, marketplace, and model parameters are disabled
in `librechat.yaml` so there is only one source of agent behavior.

## Start

Start Iva in one terminal:

```bash
npm run build
npm run start:ui
```

Build and start LibreChat and its private MongoDB in another:

```bash
docker compose --profile librechat up -d --build librechat
```

Open `http://127.0.0.1:3080`, create the first account, and select the `iva` model under the
`Iva` endpoint. `LIBRECHAT_PORT` and the loopback-only MongoDB port can be changed in `.env`.

On a remote server, forward both the LibreChat port and Iva's port from the browser's
computer. The notification bell loads its script and inbox directly from Iva's loopback
address; forwarding only LibreChat makes the chat work but leaves the bell disconnected:

```bash
ssh -L 3080:127.0.0.1:3080 -L 8723:127.0.0.1:8723 user@server
```

Then open `http://127.0.0.1:3080` on that computer. Replace `8723` if you changed
`IVA_PORT`, and rebuild LibreChat after changing that port. A different browser origin,
such as a Tailscale hostname or public HTTPS URL, needs a same-origin proxy for `/iva/*`
before its bell can work; the current browser script is configured for loopback access.

Open WebUI and LibreChat can run simultaneously. They keep separate UI accounts and chat
lists, but both conversations reach the same Iva vault, tools, memory, and model provider.
LibreChat forwards its user and conversation identifiers as headers, so each browser chat
gets its own durable Eve conversation.

Files are sent directly to Iva rather than to LibreChat RAG. Iva saves the original bytes
under `vault/attachments/`: images enter the vision path, documents are opened from that
local path, and uploaded audio is transcribed through the same Deepgram path as Telegram.
The microphone sends audio to Iva's authenticated transcription endpoint, which uses the
same Deepgram setup as Telegram and leaves the transcript in the composer for review before
sending.

## Notifications and scheduled tasks

Iva remains the only scheduler. A reminder or scheduled report is executed once and written
to `data/notifications.json`; the same event is then delivered to Telegram when Telegram is
configured. This keeps Telegram and LibreChat on one task system instead of creating a
second set of LibreChat-native jobs.

User reminders and reports go to `TELEGRAM_NOTIFICATION_CHAT_ID`; operational failures go
to the separate `TELEGRAM_DIAGNOSTIC_CHAT_ID`. Both are also written to LibreChat's inbox.

For this checkout, run CLI delivery commands as `npm run iva -- notify "text"` or
`npm run iva -- remind "text"`. The npm command loads this checkout's `.env`; do not use a
global `iva` shim until you have verified which installation it points to.

LibreChat shows Iva's bell in the top-right corner and checks the durable inbox every 15
seconds. Unread items survive a closed browser and appear when LibreChat is opened again.
Clicking the bell once also offers browser notifications; those can appear only while the
LibreChat page is open. Telegram remains the reliable push channel while the browser is
closed.

Stop only LibreChat with:

```bash
docker compose stop librechat librechat-mongodb
```

The named volumes retain accounts and conversations. Removing those volumes deletes the
corresponding LibreChat data.
