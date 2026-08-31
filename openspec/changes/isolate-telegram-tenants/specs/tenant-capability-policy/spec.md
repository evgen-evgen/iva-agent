## Purpose

Separates safe end-user capabilities from installation administration so ordinary Telegram tenants cannot control or inspect the host running Iva.

## ADDED Requirements

### Requirement: Ordinary tenants receive an allowlisted capability set

The system SHALL expose ordinary Telegram tenants only to tools and connections explicitly classified as tenant safe.

#### Scenario: Ordinary user starts a turn

- **WHEN** a non-owner tenant starts a private Telegram turn
- **THEN** the model receives tenant-scoped memory and safe user tools but does not receive arbitrary shell, host filesystem, plugin administration, personal userbot, or owner integration capabilities

### Requirement: Owner commands use separate authorization

The system MUST distinguish admission to converse from authorization to administer the installation.

#### Scenario: Admitted ordinary user sends an owner command

- **WHEN** an admitted non-owner user sends a restart, update, model configuration, maintenance, plugin, or equivalent owner-only command
- **THEN** the command is rejected before any administrative side effect

#### Scenario: Owner uses an owner command

- **WHEN** a configured owner sends an owner-only command from an authorized private chat
- **THEN** the existing administrative flow may proceed

### Requirement: Owner-only controls are not advertised to ordinary users

Help and menu surfaces SHALL omit owner-only commands and controls for ordinary tenants while server-side authorization remains authoritative.

#### Scenario: Ordinary user opens help

- **WHEN** a non-owner tenant requests help or opens the menu
- **THEN** no owner-only control is presented

### Requirement: Tenant-safe file tools enforce storage boundaries

Any file read, write, search, or listing capability exposed to an ordinary tenant SHALL be rooted in that tenant's allowed storage and SHALL reject absolute or escaping paths.

#### Scenario: Safe memory file access

- **WHEN** an ordinary tenant reads a path returned by its own memory search
- **THEN** the file is read from that tenant's vault

#### Scenario: Host path access attempted

- **WHEN** an ordinary tenant requests `.env`, another tenant's directory, or any arbitrary host path
- **THEN** the operation is rejected without returning host content

### Requirement: Authorization is enforced outside the model

Capability and command authorization MUST be enforced by application code and SHALL NOT rely on system-prompt instructions or model compliance.

#### Scenario: Model requests a forbidden action

- **WHEN** prompt injection or model error produces a call to a capability forbidden for the active tenant
- **THEN** the runtime refuses the call before invoking the underlying operation

### Requirement: Technical failures are not disclosed to ordinary user chats

The system SHALL send only a generic stopped-process notice to the failing user and SHALL route provider messages, error identifiers, stack details, and other diagnostics only to an explicitly configured separate diagnostics channel.

#### Scenario: Tenant turn fails

- **WHEN** a private tenant turn fails with technical error details
- **THEN** the user receives a generic retry or `/new` notice and the separate diagnostics channel receives the redacted technical copy

#### Scenario: Diagnostics channel is absent or unsafe

- **WHEN** no diagnostics channel is configured or its ID equals the failing user chat
- **THEN** no technical detail is sent to Telegram and the service journal remains the diagnostic source
