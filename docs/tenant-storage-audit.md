# Tenant storage call-site audit

This inventory classifies the remaining process-global path references after tenant
isolation. A new user-data call site must either take trusted `TenantContext` or be added
here with an installation-global reason.

| Area                                                                               | Classification                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/lib/data-dir.ts`, `instrumentation.ts`                                      | Installation root containing the trusted registry and shared operational logs. Never a user-memory root.                                                                                                              |
| `agent/lib/trace.ts`, `usage.ts`                                                   | Shared bounded operational diagnostics. Records carry an authenticated opaque tenant ID; they are not exposed to ordinary Telegram users or memory search.                                                            |
| `agent/tools/memory_search.ts`, `write_card.ts`                                    | Runtime execution resolves `vaultRoot` from Eve session auth. The environment fallback exists only on exported low-level helpers used by legacy unit tests and cannot be reached by a model tool call with a session. |
| `scripts/init-vault.ts`, `migrate-tenant-owner.ts`                                 | Explicit legacy-owner bootstrap/migration source. Not used for a live tenant turn.                                                                                                                                    |
| `scripts/build.ts`, `cli/update.ts`, `doctor.ts`, `account.ts`, `version-store.ts` | Owner-operated installation/update/repair paths. They inventory or preserve the legacy source and installation layout; ordinary tenants cannot invoke them.                                                           |
| `scripts/check-update.ts`, setup, service/unit writers                             | Installation-global configuration and lifecycle state.                                                                                                                                                                |
| `scripts/memory/rollup.ts`, `brain.ts`, `embed-index.ts`, `daily-digest.ts`        | Require an explicit registry-validated `--tenant-id`; model calls also require a signed tenant service grant. No live vault is selected from `ASSISTANT_VAULT_DIR`.                                                   |
| `scripts/lib/menu/character.ts`, `menu/core.ts`                                    | Resolve the callback's Telegram user through the registry before reading/writing PERSONA, CORE, or interview recovery.                                                                                                |
| `agent/lib/telegram-turn-start.ts`                                                 | Receives the already-resolved tenant vault explicitly for context-size diagnostics; it has no environment fallback.                                                                                                   |
| `scripts/replica-smoke.ts`, `health-probe.ts`, test fixtures                       | Isolated synthetic installation roots, not production user-data selection.                                                                                                                                            |

Host file and arbitrary shell capabilities remain only in the `telegram-owner` profile and
also enforce authorization at execution. Ordinary users receive tenant-relative memory
tools whose physical-path resolver rejects absolute paths, traversal, hidden metadata,
and symlink escapes.
