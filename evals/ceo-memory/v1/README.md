# CEO memory benchmark v1

This fixture tests one narrow claim:

> Can Iva preserve the current operational truth of a CEO's week without losing the history that explains it?

The benchmark is deliberately source-first. It fixes the raw transcripts, expected truth, questions, and scoring before a runner or judge is added. This prevents prompt or schema changes from quietly moving the goalposts.

## What is in v1

- Five raw daily transcripts in Iva's real `daily/YYYY-MM-DD.md` format.
- 27 source entries across a synthetic working week.
- Checkpoint truth after each day and a final state.
- 22 CEO-style recall questions with required and forbidden claims.
- A proposed `meeting` + `commitment` schema overlay for the second run.
- A deterministic fixture validator.

The scenario covers:

- a launch date superseded from 18 to 25 September;
- separate dependent commitments: Ivan's working-access deadline stays Wednesday while
  NordSupply promises credentials by Friday;
- commitments that are completed, delayed, and still open;
- a decision that must not auto-revert after its blocker disappears;
- assistant inference that must not be promoted to user-stated fact;
- two different Ivans who must not be merged;
- noise that should remain only in the transcript;
- an idea about a second supplier that must not become a decision.

## Validate the fixture

From the repository root:

```bash
npm run eval:ceo-memory:validate
```

The validator checks JSON structure, unique IDs, checkpoint names, source references, and that every mapped transcript entry exists.

## Run it yourself

The runner uses the model provider already configured in `.env`, but creates a separate
vault, data directory, temporary Eve app root/workflow store, local server, and bearer
token. It removes Telegram credentials from the benchmark process and disables answer
transcript writes. It never opens or edits the live vault or reuses its active workflows.

### Free run through OpenRouter

OpenRouter is already a first-class Iva provider. To use its free model router, put these
values in the repository's `.env` (keep the real key out of git):

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=openrouter/free
OPENROUTER_CONTEXT_WINDOW=200000
```

Then run the benchmark normally:

```bash
npm run eval:ceo-memory -- --mode stock
```

`openrouter/free` filters its current free pool for capabilities required by the request,
including tool calling. It may choose a different model for different requests, so it is
good for a zero-cost smoke run but introduces model variance into a stock-vs-CEO-schema
comparison. For a controlled `--mode both` run, use one fixed tool-capable `vendor/model:free`
slug for both modes. The runner records the configured provider and model in `run.json` and
never writes the API key there.

When `MODEL_PROVIDER=codex`, the isolated server still needs the OAuth login of the
working Iva installation. If `data/codex-auth.json` belongs to another checkout, point
only the auth seam at that installation (the token is not copied into benchmark output):

```bash
IVA_CODEX_AUTH_DATA_DIR=/path/to/working-iva/data \
  npm run eval:ceo-memory -- --mode stock
```

If neither location contains `codex-auth.json`, run `iva login` first. The benchmark
fails immediately with the expected path instead of waiting for the rollup timeout.

Start with the stock run:

```bash
npm run eval:ceo-memory -- --mode stock
```

The command performs five real daily rollups, snapshots the vault after every day, asks
the 22 questions in fresh sessions at their intended checkpoints, and writes:

```text
data/ceo-memory-benchmarks/<timestamp>/stock/
├── vault/                 final vault
├── snapshots/YYYY-MM-DD/ vault after each processed day
├── answers/answers.json  raw answers
├── artifact-validation.json mechanical memory-contract checks
├── review.md             manual scoring sheet
└── *.log                 server and rollup logs
```

The benchmark clock is frozen at the day being processed or questioned. Production Iva
continues to use the real user date and time; the override is active only inside the
isolated process marked with `IVA_MEMORY_EVAL_MODE=1`.

Each synthetic day also starts a fresh processing session. The vault persists between
days, but the model conversation does not, so the benchmark measures durable memory
rather than an increasingly long rollup chat context. Successful rollup and question
sessions are terminally reset before the next sample, so a restarted local server cannot
redeliver an earlier benchmark workflow.

After each rollup, the runner checks that the raw day has a processing marker, the daily
summary has the required frontmatter, autograph produced the graph and MOC, and the Delta
launch-date change is represented with current truth plus history. In `ceo-schema` mode it
also checks the expected number of open/done commitment cards after every day, validates
their structured fields, and verifies the exact six-item final lifecycle state. These
checks are recorded in `artifact-validation.json`. If any fail, the runner still asks all
questions and preserves every snapshot and answer, then exits with code `2` and marks
`run.json` as `completed_with_artifact_failures`. This is a benchmark failure, not a lost run.
If a rollup itself aborts, `run.json` is finalized with `status: failed`, the failed
mode, and the error message; partial logs and earlier snapshots remain available.

Completed replies in `answers.json` use `status: "completed"`. If Eve returned to its
normal idle state after producing the reply, the original `waiting` state remains visible
as `transport_status`.

Useful variants:

```bash
# Prepare both isolated vaults without spending model tokens
npm run eval:ceo-memory -- --mode both --prepare-only

# Run only rollups and inspect the resulting vault manually
npm run eval:ceo-memory -- --mode stock --skip-questions

# Compare both ontologies using identical sources and questions
npm run eval:ceo-memory -- --mode both
```

`both` costs roughly twice as many model calls as `stock`, so it is intentionally not the
default. The runner does not auto-grade answers; use the generated `review.md` together
with `rubric.md`.

## Intended experiment

### Run A — stock Iva

Use the existing vault schema and current memory processor. Copy the five source files into a clean test vault one day at a time, run the daily rollup for that exact date, snapshot the vault, and ask only the questions whose `checkpoint` has been reached.

The stock run is allowed to represent commitments inside existing `project`, `contact`, `decision`, or `note` cards. It is scored on the answer, not on a predetermined file layout.

### Run B — CEO schema

Merge `schema-ceo-extension.json` into the test vault schema and repeat the identical week and questions.

The overlay enables `meeting` and a structured `commitment` type. Every explicit promise
with an owner, deliverable, and due date must go through `write_commitment`, whose
fail-closed lifecycle owns creation, rescheduling, completion/cancellation, provenance,
current truth, and append-only history. Generic `write_card` remains schema-driven for
the other types. Old vaults without the overlay retain stock behavior; the new commitment
tool refuses to write when `node_types.commitment` is absent.

Dependent promises never inherit each other's deadlines. In this fixture NordSupply's
Friday credentials promise does not reschedule Ivan's earlier promise to provide working
access; only an explicit accepted deadline change can transition that commitment.

## What v1 does not score

Task creation is intentionally out of scope. The current nightly rollup writes cards and summaries, while `tasks.json` is managed by a separate interactive tool. A copied transcript does not replay tool side effects. `expected/truth.json` therefore contains `task_candidates`, but they are observations for the later real-time ingestion experiment, not v1 scoring targets.

Outlook, PLAUD, Calendar, reminders, dashboards, Postgres, and Qdrant are also out of scope. This benchmark isolates memory behavior before connectors or infrastructure can hide its weaknesses.

## Pass condition

Use `rubric.md`. A run passes only when it scores at least 90/100 and produces zero critical errors. The critical-error gate matters more than a fluent average answer: a CEO agent that confidently reports the old launch date has failed even if everything else sounds excellent.
