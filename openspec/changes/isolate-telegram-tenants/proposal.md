## Why

Iva can already keep private Telegram conversations in separate Eve sessions, but every allowed user currently shares one vault, task store, runtime settings, and the same host-level tools. Multiple independent Telegram users therefore cannot use the bot without memory leakage, cross-user mutation, and access to owner-only capabilities.

## What Changes

- Introduce a trusted tenant identity for every accepted private Telegram user and carry it through the complete turn lifecycle.
- Store each tenant's durable memory, transcript, attachments, tasks, indexes, and memory-job state under a tenant-owned storage boundary.
- Keep Markdown vault files as the source of truth for memory while using an embedded metadata database for tenant records, policy, and structured state; keep binary attachments outside the database behind a storage interface.
- Resolve CORE, memory search, writes, media paths, and background memory processing from trusted tenant context rather than global environment variables or model-provided paths.
- Give ordinary Telegram tenants a restricted tool and command policy; keep server administration, arbitrary host filesystem access, shell access, global model configuration, plugins, and owner integrations unavailable to them.
- Limit the first release to private Telegram chats. Group memory, per-user persona/menu customization, billing, and the development console are deferred.
- **BREAKING**: authenticated private Telegram users are registered automatically as isolated ordinary tenants; only `TELEGRAM_OWNER_USER_IDS` grants installation authority.

## Capabilities

### New Capabilities

- `tenant-identity`: Register an authenticated private Telegram sender as a stable internal tenant and preserve that identity across a turn and trusted background work.
- `tenant-memory`: Isolate durable memory, transcripts, tasks, attachments, indexes, and memory jobs so one tenant can neither read nor mutate another tenant's state.
- `tenant-capability-policy`: Expose only tenant-safe tools and commands to ordinary Telegram users while retaining an explicitly separate owner/admin policy.

### Modified Capabilities

<!-- No existing OpenSpec capabilities: this repository is being initialized with this change. -->

## Impact

- Telegram inbound/auth, channel context, media handling, provider attachment resolution, transcript hooks, and queue/control authorization.
- Dynamic CORE instructions and memory-related tools (`memory_search`, `write_card`, file access, tasks).
- Vault and data-directory layout, SQLite metadata schema, migration of the current single-user data, indexes, locks, and caches.
- Rollup, brain, digest/report delivery, and other scheduled jobs that currently run as one global internal client.
- Menu and command routing insofar as owner-only operations must be hidden and rejected for ordinary users.
- Test infrastructure must support at least two concurrent tenants and prove negative cross-tenant access.
