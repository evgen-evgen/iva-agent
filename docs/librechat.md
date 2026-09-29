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

Email login stays enabled, but browser registration is always disabled. Existing accounts
and chats remain in the named MongoDB volume. Provision only the technical administrator
and the CEO. Both will have the LibreChat `ADMIN` role:

```bash
npm run librechat:accounts -- admin@example.com ceo@example.com
```

Replace the addresses with your actual email addresses. The command reads current accounts
first and refuses to change anything if it finds an account other than those two. For each
missing account it runs LibreChat's interactive `create-user` script: enter the requested
email and password when prompted. Passwords are not arguments or stored in this repository.
Run it on the machine hosting Docker, then verify the final count and roles at any time:

```bash
npm run librechat:accounts -- --check admin@example.com ceo@example.com
```

If there are other accounts already in MongoDB, inspect them and decide separately whether
to retain or remove them; the script never deletes users. Recreate the LibreChat service
after deploying this compose file, then verify browser sign-up is unavailable and both
accounts can sign in. Open `http://127.0.0.1:3080` and select the `iva` model under the
`Iva` endpoint. `LIBRECHAT_PORT` and the loopback-only MongoDB port can be changed in `.env`.

`ADMIN` grants management rights inside LibreChat, including access to settings and other
users' LibreChat resources. It does not make the CEO an operating-system administrator.
Both browser accounts reach the same Iva vault; this is not tenant isolation.

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

User reminders and morning digests go to `TELEGRAM_NOTIFICATION_CHAT_ID`. Health and memory
reports, update offers, and operational failures go to the separate
`TELEGRAM_DIAGNOSTIC_CHAT_ID`. Both are also written to LibreChat inbox.

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
