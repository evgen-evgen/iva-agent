# Repository workflow

These instructions apply to the entire repository.

## Start of every session

1. Read this file and inspect `openspec/changes/` for active changes.
2. Continue an existing change when the requested work belongs to it; do not create a duplicate change.
3. Inspect the worktree before editing and preserve unrelated or unfinished user changes.

## Spec-first changes

Use OpenSpec before implementation when a change affects observable behavior, APIs, configuration, data or storage layout, migrations, permissions, security boundaries, tenant isolation, or user-visible workflows.

The normal sequence is:

1. Create or update the OpenSpec proposal, delta specs, design, and tasks.
2. Resolve material product or architecture decisions before changing code.
3. Implement the approved tasks in dependency order.
4. Add or update tests with the implementation.
5. Mark a task complete only after its stated verification passes.
6. Run the change-level verification, then archive the change so its requirements become canonical project specs.

Small refactors, typo/documentation corrections, and test-only maintenance may be implemented directly when they do not change a contract. If such work reveals a behavior or contract change, update OpenSpec before continuing.

## OpenSpec records

- `proposal.md`, `design.md`, and delta specs record intent and decisions.
- `tasks.md` records implementation and verification progress, not merely code written.
- Git records chronology; do not rely on checklist order as a historical log.
- Do not archive a change while required tasks or verification remain incomplete.

## Verification

Use the checks required by the active change. For `isolate-telegram-tenants`, the final gate includes:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:security`
- tenant-owner migration smoke tests
- `npm run build`

Report pre-existing failures or runner hangs explicitly. Do not mark a verification task complete unless every required check has a conclusive successful result.

## Tenant safety invariants

- Resolve tenant identity only from trusted transport or service context, never from prompt text or an untrusted payload.
- Keep memory, files, tasks, media, run state, background jobs, and personalization tenant-scoped.
- Treat the configured owner identity as authorization; ordinary Telegram users are auto-registered but never implicitly promoted.
- Keep privileged commands and tools hidden from ordinary users and enforce authorization again at execution time.
- Send users only safe failure notices. Route technical diagnostics to the explicitly configured diagnostics destination and never expose secrets, stacks, or provider internals to user chats.
