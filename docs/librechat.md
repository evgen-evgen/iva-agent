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

Start LibreChat and its private MongoDB in another:

```bash
docker compose --profile librechat up -d librechat
```

Open `http://127.0.0.1:3080`, create the first account, and select the `iva` model under the
`Iva` endpoint. `LIBRECHAT_PORT` and the loopback-only MongoDB port can be changed in `.env`.

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

Stop only LibreChat with:

```bash
docker compose stop librechat librechat-mongodb
```

The named volumes retain accounts and conversations. Removing those volumes deletes the
corresponding LibreChat data.
