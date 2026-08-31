## 1. Tenant foundation

- [x] 1.1 Add `TenantContext`, identity normalization, and fail-closed resolver APIs; verify unit tests cover same-user stability, different-user separation, unsupported principals, and concurrent resolution.
- [x] 1.2 Implement the SQLite tenant registry with schema migrations, WAL configuration, opaque IDs, roles, status, and Telegram destinations; verify registry CRUD, uniqueness, restart persistence, and corrupt-schema failure tests.
- [x] 1.3 Auto-register authenticated private users while keeping owner authorization in configuration; verify a new user is not implicitly an owner and configured owners retain authorization.
- [x] 1.4 Add tenant-root creation with restrictive permissions and a per-tenant `state.sqlite`; verify two tenants receive distinct physical roots and databases.

## 2. Tenant storage boundary

- [x] 2.1 Implement tenant-relative path resolution with traversal, absolute-path, and physical symlink escape protection; verify unit and property tests cannot escape a tenant root.
- [x] 2.2 Add the local-filesystem `BlobStore` with opaque attachment IDs and tenant-owned metadata; verify save/read/delete and cross-tenant resolution-denial tests.
- [x] 2.3 Move tasks from global JSON storage to tenant `state.sqlite` with transactional mutation; verify task IDs and lists are independent across two tenants and survive restart.
- [x] 2.4 Refactor transcript and non-file Telegram persistence to require tenant storage explicitly; verify inbound, buffered, location/contact/poll, and completed assistant entries land only in the originating tenant daily file.

## 3. Telegram and Eve context propagation

- [x] 3.1 Register and resolve authenticated private Telegram senders before any persistence and attach trusted tenant identity to Eve auth; verify missing identities and non-private chats produce no tenant write or model turn.
- [x] 3.2 Resolve `TenantContext` from Eve `SessionContext` in hooks, tools, and dynamic instructions without per-turn environment mutation; verify overlapping turns retain their own tenant roots.
- [x] 3.3 Scope run status, cancellation, and reset behavior without weakening existing per-chat serialization; verify existing Telegram queue/reset/cancel suites and new two-user cases pass.
- [x] 3.4 Add scoped internal service grants for background work and reject unscoped service principals; verify a scheduled caller cannot choose a tenant through prompt text or request payload lacking trusted authorization.

## 4. Memory and media conversion

- [x] 4.1 Load CORE and the initial neutral/persona file from the active tenant vault; verify tenant A's system context never contains tenant B's CORE or owner customization.
- [x] 4.2 Convert `memory_search`, card storage, indexes, and graph paths to tenant stores; verify searches, reads, adds, updates, and supersedes cannot observe another tenant.
- [x] 4.3 Replace generic model-facing memory file operations with tenant-relative read/write/list/search operations; verify absolute paths, `.env`, sibling tenant paths, and symlink escapes are rejected without existence disclosure.
- [x] 4.4 Convert Telegram media cache and saving to `BlobStore` and emit opaque references; verify text, voice, documents, photos, albums, and rich media preserve tenant ownership.
- [x] 4.5 Make provider image replay resolve opaque attachments using active trusted tenant context; verify forged and cross-tenant references never attach bytes to a model request.

## 5. Capability and command policy

- [x] 5.1 Introduce runtime `telegram-user` and `telegram-owner` capability profiles; verify ordinary turns cannot discover or call shell, arbitrary host files, plugin administration, userbot, or owner integrations.
- [x] 5.2 Add execution-time authorization to every privileged tool/connection retained for owners; verify direct forged tool calls are refused independently of model-visible tool filtering.
- [x] 5.3 Classify Telegram commands and callbacks as user-safe or owner-only and enforce registry roles before effects; verify ordinary users cannot change model/thinking, restart/update, run maintenance, or invoke stale privileged callbacks.
- [x] 5.4 Filter help and menu surfaces by capability profile while leaving later tenant personalization extensible; verify ordinary UI omits owner controls and owner UI retains them.
- [x] 5.5 Keep user-facing failure notices generic and route technical details only to an explicitly separate diagnostics channel; verify provider messages, error IDs, stacks, and secrets never reach the failing user chat.

## 6. Tenant-aware background memory

- [x] 6.1 Enumerate active tenants with bounded concurrency and tenant-specific job locks/cursors; verify one tenant's running or failed job does not block another tenant.
- [x] 6.2 Convert daily/weekly/monthly/yearly rollup, brain maintenance, embeddings, graph generation, and cleanup to explicit tenant roots; verify fixtures for two tenants produce no cross-tenant reads or writes.
- [x] 6.3 Route digest and memory reports to the active tenant's registered destination and store tenant-attributed status; verify a report generated for tenant A is never sent to tenant B.
- [x] 6.4 Attribute shared trace and usage records to opaque tenant IDs without making them user-retrievable; verify redaction/content limits and existing trace/usage behavior remain intact.

## 7. Migration and operations

- [x] 7.1 Add a dry-run migration that requires exactly one explicit owner identity and inventories the current vault and compatible structured state; verify ambiguity stops before filesystem mutation.
- [x] 7.2 Implement staged owner migration with backup, hashes/count verification, atomic publication where possible, and rollback metadata; verify success and injected-failure rollback tests preserve the original data.
- [x] 7.3 Update setup, configuration, doctor, deployment, backup, and recovery documentation for tenant registry, owner authorization, storage layout, and private-chat-only behavior; verify documented commands against a fixture installation.

## 8. Isolation verification

- [x] 8.1 Add an end-to-end two-tenant harness covering simultaneous text, tasks, cards, CORE, media, search, responses, reset, and restart; verify a unique secret from tenant A is absent from every tenant B output and observable result.
- [x] 8.2 Add adversarial tests for traversal, absolute paths, symlinks, forged attachment IDs, prompt-selected tenant IDs, forbidden tools, owner callbacks, and group messages; verify all cases fail closed.
- [x] 8.3 Audit remaining `ASSISTANT_VAULT_DIR`, `ASSISTANT_DATA_DIR`, host-file, and internal-service call sites; verify every user-data access is either tenant scoped or explicitly documented as installation-global.
- [ ] 8.4 Run typecheck, lint, complete tests, security tests, migration smoke tests, and a production build; verify all pass before admitting a second non-owner tenant.
  - Verification on 2026-08-31: typecheck, lint, security tests, tenant-owner migration tests, and the production build pass under Node 24.20.0.
  - The complete suite is not yet green. Confirmed blockers include poller durability fixtures that still encode pre-change group/allowlist callback behavior (7 failures in the isolated suite) and 2 failing leaf tests in the unrelated update recovery suite even with `umask 022`. Keep this gate open until all failures are resolved and the complete suite exits successfully.
