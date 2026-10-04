# LibreChat

LibreChat is an optional alternative browser UI for the same Iva runtime. It connects to
Iva's OpenAI-compatible `/v1` endpoint; models and tools still run inside Iva. LibreChat's
own agents, prompts, memory, MCP, skills, web search, file search, marketplace, and model parameters are disabled
in `librechat.yaml` so there is only one source of agent behavior.

Full Iva startup with Telegram, Mail and Plaud (Russian):
[End-to-end guide](ru/full-startup.md).

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

On a remote server, forward the LibreChat port. Its authenticated same-origin proxy relays
the notification bell to Iva, so Iva's private port does not need to be exposed:

```bash
ssh -L 3080:127.0.0.1:3080 user@server
```

Then open `http://127.0.0.1:3080` on that computer. The same setup also works behind a
Tailscale hostname or public HTTPS reverse proxy.

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
`TELEGRAM_DIAGNOSTIC_CHAT_ID`. Both are also written to the durable LibreChat inbox. `LIBRECHAT_NOTIFICATION_USERS`
controls which authenticated email accounts may open that inbox. Read state is tracked
separately for every account. `LIBRECHAT_NOTIFICATION_SECRET` authenticates the internal
LibreChat-to-Iva proxy and must be the same non-empty value in both processes.

For this checkout, run CLI delivery commands as `npm run iva -- notify "text"` or
`npm run iva -- remind "text"`. The npm command loads this checkout's `.env`; do not use a
global `iva` shim until you have verified which installation it points to.

Reports appear as ordinary LibreChat conversations in the native project **Входящие Ивы**.
Each permitted account owns its own project and conversations. The report is the first
assistant message; existing report discussions are imported as the following message
chain. Continue using LibreChat's standard composer. Iva seeds a fresh runtime session
from the stored chat history, so the first question already has the report as context.

The bell in the top-right corner is for notifications and simple reminders. Selecting a
report navigates to its normal `/c/<conversationId>` chat. Selecting a reminder expands
its full text inside the bell without creating a conversation or a second composer.
The bell polls every 15 seconds, loads 50 notifications at a time and offers **Show more**.
Read state is tracked per account and survives a closed browser.

Report creation calls LibreChat's server-only synchronization hook, so native chats also
appear while the browser is closed. Authenticated inbox reads retry imports if LibreChat
was unavailable. Rebuild/recreate only the `librechat` service after changing the native
integration. Its `LIBRECHAT_NOTIFICATION_USERS` must match Iva's allowed reader list.
Imports are idempotent and retain original Markdown, images and discussion timestamps;
subsequent polling respects user renames, project moves, archives and chat deletion.
The old archive and `data/report-discussions/` files remain intact as migration sources.

Set `LIBRECHAT_PUBLIC_URL` in Iva's `.env` to the browser-accessible HTTP(S) address of
LibreChat (the same address used by its container). Scheduled reports send a short
Telegram notice with **Open in Libre** and **Show here** buttons. The morning digest says
the report and plan are ready. The first button resolves `?iva_report=<id>` to the signed-in account's native chat;
the second retrieves the saved report without regenerating it. Telegram users must be
allowlisted and use a private chat to retrieve reports. Reminders and operational alerts
retain their existing delivery. Without a configured public URL the report is saved, but
Telegram delivery is marked failed with a configuration error; no guessed localhost link
is sent. Without Telegram configuration the morning digest still runs and saves to Libre.
Telegram's **Show here** retrieves the report; replies in Telegram continue in the normal
Telegram conversation, rather than the report conversation in LibreChat.

Clicking the bell once also offers browser notifications; those can appear only while the
LibreChat page is open. Telegram remains the reliable push channel while the browser is
closed.

Stop only LibreChat with:

```bash
docker compose stop librechat librechat-mongodb
```

The named volumes retain accounts and conversations. Removing those volumes deletes the
corresponding LibreChat data.

## Delayed assignments versus reminders

Use `schedule_task` when the owner asks Iva to perform work later, such as research,
searching for vehicles, or preparing a report. The timer runs this checkout's
`iva run-task`, executes the assignment with tools, archives the final report and sends
Telegram's ready buttons. An execution error creates an actionable alert rather than a
reminder claiming success. `TASK_TURN_TIMEOUT_MS` bounds execution (default: ten minutes).

Use `schedule_reminder` only when the owner asks to be reminded to do something themselves.
It runs `iva remind` and retains the existing reminder behavior. Never promise that a
reminder will execute an assignment.

The inbox is account-restricted. Include every intended reader's email in
`LIBRECHAT_NOTIFICATION_USERS` and restart Iva after changing it. The UI now displays an
explicit access error for other accounts and restores authentication when its loader runs
after LibreChat's sign-in event. Refresh the browser after deploying UI changes.

For a CEO installation alongside other Ivas, use `deploy/iva-ceo-runtime.service` and
`deploy/iva-ceo-telegram-poll.service`, replacing `__PROJECT_DIR__` with the absolute project
path and `__NODE__` with the absolute Node 24 executable before installing them as user
units. These use distinct names; do not use the generic `iva restart` command when
`iva.service` belongs to another installation. Stop any foreground CEO processes before
starting the corresponding services. Restart only these units after rebuilding:

```bash
systemctl --user restart iva-ceo-runtime.service iva-ceo-telegram-poll.service
```

Then open LibreChat, check the inbox under the intended account, and schedule a small
assignment such as a calculation. Verify the original instruction selected `schedule_task`,
the saved notification is a `report`, Telegram received its buttons, and a question under
the report persists after reopening. The source snapshot cache also includes actual file
contents, so a development rebuild without a new Git commit picks up new tools.

The daily memory rollup skips a day with no source transcript before starting a model
turn. It does not invent a summary or advance the vault's last processed day. Unreadable
input and failures on days that have source records still fail visibly.
