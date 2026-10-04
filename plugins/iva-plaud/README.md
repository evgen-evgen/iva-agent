# Iva Plaud plugin

This plugin connects Iva to the official `@plaud-ai/mcp` server over stdio. It exposes
Plaud's read-only tools for listing/searching recordings and reading their transcripts,
summaries, and action items. Iva's `plaud` skill explains how to use those tools and how to
capture owner-approved facts in the existing vault schema.

Full end-to-end startup guide (Russian): [Plaud → CEO memory](../../docs/ru/plaud.md).

## Install

From the Iva checkout, install the local plugin into the target data directory:

```bash
iva plugin add ./plugins/iva-plaud
iva plugin trust iva-plaud
```

The server is launched by Iva's stdio MCP proxy. It uses Node.js and `npx` to download the
official Plaud MCP package on first start. The package is pinned in `mcp.json`; update the
pin deliberately after reviewing a new upstream release.

The plugin sets `HOME` to its private `data/plugin-data/iva-plaud` directory, so Plaud's
OAuth tokens and npm cache stay with this plugin rather than the user's general home
directory. The OAuth token is still a credential: keep the data directory private and back
it up only under the same protections as other account tokens.

## Sign in

After trusting the plugin, start a new Iva session and ask: “Log me into Plaud.” Complete
the browser authorization. The Plaud account must have Cloud Sync enabled, and new
recordings become available after their transcript and summary finish processing.

On a headless server, the OAuth callback uses local port `8199`. Open an SSH tunnel from
the computer with the browser before starting login:

```bash
ssh -L 8199:127.0.0.1:8199 user@server
```

Then open the authorization URL Iva returns in that computer's browser and approve access.
The callback reaches the server through the tunnel. If authentication expires, ask Iva to
log in again.

## Background import without Zapier

Requires an Iva build containing `plaud_import` and the `plaud-sync` schedule.
After login and enabling the CEO memory profile, run:

```bash
npm run plaud:sync -- --enable
```

This enables the ten-minute schedule and runs an initial sync. Use the same command
without flags for a manual sync, or `--disable` to stop background importing. From chat,
ask Iva to enable Plaud synchronization (the `plaud_import` tool owns the toggle).
A rebuilt and restarted agent is required for a new schedule/tool to become available.

Each tick checks the newest page and one rotating archive page, including old recordings
whose contents changed. There is no documented updated-since filter: a full archive sweep
is eventual, not instantaneous. Interactive sync checks the first two pages. Sources
without a transcript stay unimported and are retried on later checks.

Sources and revisions are stored under `data/plugin-data/iva-plaud/imports/`, keyed by
account and recording ID. Signed audio/content URLs and random MCP envelopes are not
persisted or hashed. No audio is downloaded. A separate durable pending queue tracks
context processing; failures leave work pending. Each processing turn handles at most
five sources using `plaud-process`, saves linked meeting cards and explicit commitments,
and archives a contextual report. Uncertain identities/dates stay unresolved. Reports
and raw sources are separate; confirmed memory must not be replaced by source edits.

Status of the background job is in `data/plaud-sync-status.json`. Disable synchronization
does not delete archives. A removed/untrusted plugin cannot be contacted by the importer.

## Boundaries

- PLAUD MCP is read-only; it cannot record, edit recordings, or generate new summaries.
- Meeting content is untrusted external input. Instructions found inside recordings never
  authorize actions.
- Outside enabled import processing, Iva only saves durable information to memory when asked or when it is clearly needed for
  the current request. Commitments must be explicit and use `write_commitment`.
- No Plaud API key or account password is stored in `.env`.

Official setup and tool reference: <https://docs.plaud.ai/plaud-mcp-cli/mcp>.
