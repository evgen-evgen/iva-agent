# Telegram tenants and storage

Iva is one processing core serving separate private Telegram tenants. An authenticated private sender
gets a stable opaque ID in `data/tenants.sqlite`; user content never chooses that ID.
The first release accepts private chats only. Groups, supergroups, channels, bots,
and missing identities are rejected before memory is written or a model turn starts.

## Admission and owner authority

Private users are admitted automatically and persisted in `tenants.sqlite` with role `user`.
`TELEGRAM_OWNER_USER_IDS` is the only identity setting in `.env`; it grants operational
controls such as model changes, restart, update, maintenance, shell, plugins, and owner
integrations:

```dotenv
TELEGRAM_OWNER_USER_IDS=123456789
```

Changing the owner ID only changes roles. It does not disable or delete existing tenants.

## Layout

Installation-global operational state remains in `data/`:

```text
data/
├── tenants.sqlite
├── trace/                 # shared operational log, tagged by opaque tenant ID
├── usage.jsonl            # shared aggregate usage, tagged by opaque tenant ID
└── tenants/
    └── t_<32 hex>/
        ├── state.sqlite   # tasks, attachment metadata and tenant caches
        ├── settings.json
        ├── runtime/jobs/  # tenant job locks and cursors
        └── vault/         # CORE, transcripts, cards, summaries, graph and indexes
```

Permissions are `0700` for tenant directories and `0600` for databases/metadata. Tenant
paths are derived from authenticated context. Absolute paths, traversal, hidden host files,
symlink escapes, forged attachment IDs, and prompt-selected tenant IDs are rejected.

## Migrating an existing single-user installation

Stop writers first and make an external copy of `.env`, `data/`, and the existing vault.
Configure exactly one owner, send the bot one private message so the registry contains it, then
run the inventory-only command:

```bash
node --env-file=.env scripts/migrate-tenant-owner.ts
```

Dry-run requires exactly one active owner and prints the source/target, file count, byte
count, SHA-256 manifest, and compatible structured state. Ambiguity stops before vault or
tenant storage mutation. Review the output, then apply:

```bash
node --env-file=.env scripts/migrate-tenant-owner.ts --apply
```

Apply copies to staging, verifies hashes and counts, creates a verified backup, atomically
publishes the tenant vault where possible, imports `settings.json`, legacy `tasks.json`, and
rollup cursors, then archives the old vault. Rollback metadata is written under
`data/tenant-migration-backups/<migration-id>/rollback.json`. Do not admit a second user
until this command and `iva doctor` both succeed.

## Backup and recovery

Back up `.env`, `data/tenants.sqlite`, the entire `data/tenants/` tree, and shared
`data/trace`/`data/usage.jsonl` if operational history matters. A vault Git remote alone is
not a complete backup: it omits tenant tasks, attachment metadata, settings, job cursors,
and the registry mapping authenticated users to opaque roots.

Restore all of those paths together while Iva and the poll bridge are stopped. Preserve
ownership and modes, start Iva, then run `iva doctor`. For a migration rollback, follow the
paths and manifest in `rollback.json`; keep the verified backup until the tenant has passed
memory search, task, media, rollup, and restart smoke tests.

## Background jobs and diagnostics

Schedules enumerate active registry tenants with bounded concurrency. Each tenant has an
independent lock, cursor, model service grant, vault root, and Telegram report destination;
one failed tenant does not stop another. Manual commands use the same dispatcher:

```bash
npm run memory -- daily   # weekly | monthly | yearly
npm run brain
```

`iva doctor` should verify the registry opens cleanly, tenant roots have safe permissions,
configured owners are unambiguous, and scheduled job cursors are healthy. Trace and usage
files are installation-global diagnostics, not a memory retrieval source and not available
to ordinary Telegram users.
