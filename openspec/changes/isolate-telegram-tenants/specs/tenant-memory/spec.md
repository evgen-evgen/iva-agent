## Purpose

Defines the privacy boundary for each tenant's durable memory, structured state, files, indexes, and automated memory processing.

## ADDED Requirements

### Requirement: Durable state is tenant scoped

The system SHALL store and retrieve each tenant's CORE memory, transcripts, cards, summaries, tasks, settings required by memory processing, indexes, locks, caches, and job cursors within that tenant's storage boundary.

#### Scenario: Tenant writes memory

- **WHEN** tenant A creates a transcript entry, task, or memory card
- **THEN** the new state is persisted under tenant A and is absent from tenant B's reads and searches

#### Scenario: Tenant reads memory

- **WHEN** tenant B searches memory using terms that only occur in tenant A's state
- **THEN** the search returns no content, path, metadata, or existence signal from tenant A

### Requirement: Memory paths come from trusted tenant context

The system MUST resolve memory roots from trusted tenant context and MUST NOT permit message text, model arguments, relative traversal, absolute paths, symbolic links, or mutable process environment to escape the selected tenant boundary.

#### Scenario: Cross-tenant path requested

- **WHEN** a tenant-scoped tool is given an absolute path or a path that resolves outside the tenant boundary
- **THEN** the tool rejects the operation without revealing whether the target exists

#### Scenario: Symbolic link escapes the tenant root

- **WHEN** a path inside a tenant directory resolves through a symbolic link to another tenant or host path
- **THEN** the operation is rejected

### Requirement: Transcripts preserve tenant attribution

Inbound user content and completed assistant responses SHALL be written to the same resolved tenant's transcript, including buffered messages and non-text Telegram parts.

#### Scenario: Assistant completes a response

- **WHEN** a tenant-scoped turn produces its final assistant response
- **THEN** the response is appended only to that tenant's current transcript

### Requirement: Attachments remain tenant scoped end to end

The system SHALL scope attachment storage, media-cache records, model-visible attachment references, and provider-side attachment resolution to the originating tenant.

#### Scenario: Image is sent by tenant A

- **WHEN** tenant A sends an image that is attached to a model request
- **THEN** only tenant A's storage is used to save, cache, resolve, and replay that image

#### Scenario: Forged attachment reference

- **WHEN** model or message text contains a path naming another tenant's attachment
- **THEN** provider attachment resolution does not read or attach that file

### Requirement: Automated memory processing is isolated

Rollup, brain maintenance, embedding indexes, graph generation, cleanup, and reports SHALL operate on one explicit tenant at a time with tenant-specific locks and cursors.

#### Scenario: Daily rollup executes

- **WHEN** the daily memory schedule processes tenant A
- **THEN** it reads and writes only tenant A's memory and sends any enabled report only to tenant A's configured destination

#### Scenario: One tenant job fails

- **WHEN** tenant A's memory job fails
- **THEN** tenant B's memory state, cursor, lock, and scheduled processing remain unaffected

### Requirement: Existing owner memory migrates without silent loss

The migration SHALL assign the current single-user vault and compatible structured state to an explicitly configured owner tenant, preserve a recoverable backup or rollback path, and create empty memory for other tenants.

#### Scenario: Existing installation upgrades

- **WHEN** an installation with an existing vault performs the tenant migration
- **THEN** the configured owner retains the existing memory and no new tenant receives a copy

#### Scenario: Owner tenant is ambiguous

- **WHEN** migration cannot identify exactly one owner tenant
- **THEN** migration stops before moving user data and reports the required configuration
