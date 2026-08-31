## Context

See `proposal.md` for motivation and the three delta specs for behavioral requirements.

Eve is the agent runtime framework: it discovers authored channels, instructions, hooks, tools, and schedules; owns durable conversation sessions; runs the model/tool loop; compacts history; and emits lifecycle events. Its `telegram:` continuation namespace prevents a Telegram conversation key from colliding with an identically shaped key from another Eve channel. That namespace identifies transport/session ownership, not application users and not memory ownership.

Iva is the application built on Eve. Tenant identity, storage selection, permissions, memory policy, and Telegram product behavior belong to Iva. Eve already carries authenticated caller metadata in `SessionContext`, while Telegram inbound also has the sender identity before a session exists. Current memory code ignores both and resolves global paths from environment variables.

The installation targets a small self-hosted VPS, uses Node 24, depends on plain Markdown vaults and Python maintenance scripts, and benefits from Obsidian compatibility. The design must permit concurrent turns without switching process-global environment variables.

## Goals / Non-Goals

**Goals:**

- Establish one enforceable tenant boundary from Telegram ingress through model execution, tools, storage, attachments, and background jobs.
- Preserve Eve as the model/session engine while making Iva the tenant-aware processing core.
- Keep local deployment simple: embedded metadata storage and local files, with no required external database service.
- Make a future object-storage backend possible without changing memory semantics.
- Separate user admission from installation-owner authorization.

**Non-Goals:**

- Supporting group or channel memory in the first release.
- Treating the development console as a supported end-user surface.
- Public self-registration, billing, quotas, or abuse automation.
- Per-user character, language, notification, and full menu personalization in this change; the tenant storage layout must leave room for them.
- Strong process/container isolation between tenants. This change provides application-enforced data and capability isolation in one process.

## Decisions

### 1. Eve remains the runtime; Iva owns tenancy

No fork or replacement of Eve is required. Eve continuation keys continue to isolate conversation histories by channel. Iva introduces a separate `TenantContext` used by application storage and policy:

```ts
type TenantContext = {
  tenantId: string;
  role: "owner" | "user" | "service";
  dataRoot: string;
  vaultRoot: string;
};
```

Telegram private ingress resolves this context from authenticated sender identity. Eve callbacks resolve it from `ctx.session.auth`; trusted scheduled work receives a scoped service identity. Conversation routing keys and tenant identifiers remain deliberately separate.

Alternative considered: encode tenant paths into Eve continuation tokens. Rejected because continuation tokens are session-routing implementation details, do not cover pre-session persistence or background jobs, and would couple memory security to one channel adapter.

### 2. Use an opaque tenant registry backed by SQLite

A global embedded SQLite registry under `ASSISTANT_DATA_DIR` maps an identity tuple such as `(authenticator, issuer, external_principal)` to an opaque tenant ID and stores status, role, and Telegram delivery destination. External IDs are never used directly as filesystem paths.

Each tenant receives a separate `state.sqlite` for structured tenant state such as tasks and future personalization settings. Separate files improve backup, deletion, corruption containment, and inspection compared with placing every tenant's private rows in one database. SQLite is already available through Node 24 and requires no database daemon.

Alternative considered: one shared relational database with `tenant_id` on every table. Rejected for the first version because one omitted predicate could expose another tenant and because the expected deployment scale does not justify that operational trade-off.

### 3. Keep Markdown and large attachments outside the database

The tenant layout is:

```text
data/
  tenants.sqlite
  tenants/<opaque-id>/
    state.sqlite
    runtime/
    vault/
      CORE.md
      daily/
      cards/
      summaries/
      attachments/
```

Markdown remains the canonical memory representation. This preserves existing memory rules, `write_card`, maintenance scripts, Git/backup workflows, and optional Obsidian use.

Attachments use a `BlobStore` interface. The initial backend stores objects beneath the tenant root and returns opaque attachment IDs, not host paths. A later S3-compatible backend can implement the same interface. Attachment metadata records tenant ownership and content properties; every resolution requires both trusted tenant context and attachment ID.

SQLite BLOB storage is technically viable, especially for small objects, but is not selected because Telegram media can be large and the current pipeline and operational tools work with files. MongoDB GridFS is intended for chunked file storage but would introduce a database service and discard the benefits of the existing Markdown/file workflow. S3-compatible object storage is a future scaling option, not a first-release dependency.

### 4. Tenant context is explicit and immutable per operation

Storage functions change from global lookups such as `VAULT()` or `dataDir()` to APIs that require `TenantContext` or a previously bound tenant store. Code MUST NOT mutate `process.env.ASSISTANT_VAULT_DIR` per turn.

Pre-session Telegram processing receives tenant context explicitly from the verified inbound identity. Tools, hooks, and dynamic instructions use Eve's callback context. Lower-level operations accept resolved tenant stores instead of re-reading identity. This prevents concurrent turns from changing one another's roots.

Paths are resolved against the physical tenant root with traversal and symlink escape checks. Tenant-safe APIs accept vault-relative paths only. Generic absolute-path tools are not part of the user capability profile.

### 5. Replace model-visible attachment paths with opaque references

Incoming media is saved through the tenant's `BlobStore`. The model receives an opaque attachment reference. The provider attachment layer resolves it through the active trusted tenant context and refuses references owned by any other tenant.

Alternative considered: retain filesystem paths containing tenant IDs. Rejected because paths become prompt-visible capabilities, are forgeable by the model, and leak storage layout.

### 6. Capability profiles are selected outside the model

Static tool availability is split into at least two profiles:

- `telegram-user`: tenant memory/search/card/task tools and explicitly safe network tools.
- `telegram-owner`: the user profile plus approved installation administration.

Host `bash`, arbitrary `read_file`/`write_file`/`grep`/`glob`, plugin administration, global provider settings, the personal Telegram userbot, and owner integrations are absent from the ordinary profile. Tenant-safe memory file operations enforce their root again during execution. This is defense in depth: hiding a tool from the model is not the only authorization check.

Out-of-band Telegram commands use the same registry role. Help and menu rendering filter owner controls, and handlers independently reject unauthorized callbacks and commands.

### 7. First release is private-chat only

Private chat session history is already separated by Telegram chat routing. Group/supergroup turns are rejected before tenant memory persistence because an Eve group conversation can contain multiple current principals. A later spec can define group-owned memory or participant isolation explicitly.

### 8. Background jobs use scoped service grants

The scheduler enumerates active tenants from the registry and dispatches one job per tenant with bounded concurrency. A trusted internal grant identifies the target tenant in authenticated execution context; prompt text cannot select or override it.

Locks, rollup cursors, abandoned-session logs, indexes, and status files live under the tenant runtime root. Reports use the tenant's registered delivery destination. Failure of one job is recorded for that tenant and does not stop the remaining tenants.

### 9. Operational logs may remain shared but are tenant attributed

Trace and aggregate usage logs may remain installation-level operational files, provided every user turn carries the opaque tenant ID, ordinary users cannot query the logs, and existing content/redaction limits remain enforced. User-facing memory and raw attachments never use the shared trace as a retrieval source.

## Risks / Trade-offs

- **[Application isolation is weaker than process isolation]** → Remove host-level capabilities from ordinary profiles, enforce roots at execution, and keep container/per-process isolation as a future hardening option.
- **[A missed global path lookup can reintroduce leakage]** → Inventory every vault/data access, make tenant arguments mandatory, and add two-tenant negative and concurrency tests before enabling a second user.
- **[SQLite registry becomes a coordination point]** → Use transactions, WAL mode, short writes, schema migrations, and backup the registry together with tenant roots.
- **[Many tenant directories and databases increase maintenance work]** → Centralize creation/deletion in a tenant store service and iterate through the registry rather than scanning arbitrary directories.
- **[Background model calls could run at excessive concurrency]** → Use a bounded worker pool and per-tenant job locks.
- **[Migration can strand existing memory]** → Require an explicit owner mapping, use a staged copy/rename with verification, and retain a recoverable pre-migration backup until successful startup.
- **[Existing scripts assume one global vault]** → Add an explicit tenant argument/environment only to isolated child processes; never change the long-running agent process environment per turn.

## Migration Plan

1. Add the registry and tenant-store schema without changing current routing.
2. Require an explicit owner Telegram identity and create the owner tenant in a dry-run migration report.
3. Stop writer services, create a recoverable backup, and move or copy the existing vault and compatible structured state into the owner tenant root.
4. Verify counts, hashes for moved files, schema integrity, and tenant-root permissions before switching the runtime.
5. Enable tenant-aware storage and owner capability policy while keeping admission limited to the owner.
6. Run isolation, restart, rollup, and rollback smoke tests; then admit a second test tenant with an empty vault.
7. Roll back by stopping writers, restoring the backed-up single-user paths and prior runtime version, and leaving the tenant registry unused. Do not merge tenant data back into one vault automatically.
