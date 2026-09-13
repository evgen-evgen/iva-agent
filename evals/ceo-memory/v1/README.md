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
- a supplier deadline moved from Wednesday to Friday;
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
vault, data directory, local server, and bearer token. It removes Telegram credentials
from the benchmark process and disables answer transcript writes. It never opens or edits
the live vault.

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
├── review.md             manual scoring sheet
└── *.log                 server and rollup logs
```

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

`write_card` now loads writable card types and their folders from `schema.json.card_type_dirs` at server startup. Old vaults without that field retain the five stock types through a compatibility fallback.

## What v1 does not score

Task creation is intentionally out of scope. The current nightly rollup writes cards and summaries, while `tasks.json` is managed by a separate interactive tool. A copied transcript does not replay tool side effects. `expected/truth.json` therefore contains `task_candidates`, but they are observations for the later real-time ingestion experiment, not v1 scoring targets.

Outlook, PLAUD, Calendar, reminders, dashboards, Postgres, and Qdrant are also out of scope. This benchmark isolates memory behavior before connectors or infrastructure can hide its weaknesses.

## Pass condition

Use `rubric.md`. A run passes only when it scores at least 90/100 and produces zero critical errors. The critical-error gate matters more than a fluent average answer: a CEO agent that confidently reports the old launch date has failed even if everything else sounds excellent.
