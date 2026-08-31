## Purpose

Establishes a trusted, stable tenant identity for each authenticated private Telegram user and for internal work performed on that user's behalf.

## ADDED Requirements

### Requirement: Private Telegram users resolve to stable tenants

The system SHALL automatically register and resolve every authenticated private Telegram sender to exactly one stable internal tenant identifier derived from authenticated inbound identity, not from message text or model output.

#### Scenario: Same sender returns

- **WHEN** the same Telegram user sends private messages in separate turns
- **THEN** both turns resolve to the same tenant identifier

#### Scenario: Different senders use private chats

- **WHEN** two different Telegram users send private messages
- **THEN** their turns resolve to different tenant identifiers

### Requirement: Tenant resolution fails closed

The system MUST reject tenant-scoped processing when the authenticated identity is missing or unsupported. A valid first-time private Telegram user MUST be registered as an active ordinary tenant.

#### Scenario: Missing sender identity

- **WHEN** a private Telegram update has no usable authenticated sender identity
- **THEN** the system starts no model turn and writes no tenant data

#### Scenario: Unknown internal principal

- **WHEN** an internal or scheduled request does not carry an authorized target tenant
- **THEN** the request cannot fall back to an owner, default, or global tenant

### Requirement: Tenant identity survives the complete turn

The system SHALL make the resolved tenant identity available to instructions, hooks, tools, media processing, provider attachment resolution, and response persistence without consulting mutable process-global state.

#### Scenario: Concurrent tenant turns

- **WHEN** turns for two tenants execute concurrently
- **THEN** every operation in each turn continues to use the tenant selected at that turn's trusted ingress

### Requirement: Background work carries delegated tenant identity

Every background memory or digest job SHALL execute with an explicit trusted target tenant and SHALL NOT select its tenant from prompt content.

#### Scenario: Scheduled memory job

- **WHEN** the scheduler starts a memory job for a tenant
- **THEN** the job's tools and persistence resolve to that tenant even though the caller is an internal service

### Requirement: First release accepts private chats only

Tenant-scoped model turns in the first release SHALL accept private Telegram chats and SHALL reject group, supergroup, and channel updates from entering personal tenant memory.

#### Scenario: Group message received

- **WHEN** a user addresses the bot from a group or supergroup
- **THEN** the system does not start a tenant-memory turn for that message
