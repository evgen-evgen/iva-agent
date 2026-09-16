---
name: memory-processor
description: >-
  Iva's daily-memory processor. Reads the day's two-sided transcript
  (daily/YYYY-MM-DD.md), distills noteworthy entities / decisions / ideas
  into typed autograph cards, links them into the graph, and produces a
  daily-summary card (topics + MOC) that navigates down to the raw transcript and
  up to the week. Model-agnostic — runs on any LLM driving the vault (Iva uses
  DeepSeek). Triggered by the daily rollup (scripts/memory/rollup.ts daily).
depends_on: [autograph]
---

# memory-processor — daily transcript → cards + summary

Turn one day of raw conversation into durable, navigable memory.

This skill is **judgment-first**: the model (you) does the classification, tagging,
and linking. The autograph Python scripts are used only for mechanical work
(enforce schema, repair links, generate MOCs, decay, touch). `enrich.py` is **never**
used — you are the enrichment.

## Inputs

- `daily/YYYY-MM-DD.md` — the day's raw two-sided transcript
  (`## HH:MM [text|voice|video|photo|forward from: …]` for the user,
  `## HH:MM [iva]` for Iva's replies; older days may use legacy `[eva]`).
  See `scripts/memory/instructions/rules/daily-format.md`.
- `schema.json` — the vault schema (types, domains, decay).
- Existing cards under `cards/**` and prior summaries under `summaries/`,
  `weekly|monthly|yearly/` — for linking and dedup.

## Outputs

1. Zero or more **entity/decision/idea cards** under `cards/<kind>/`.
2. One **daily-summary card** at `summaries/daily/YYYY-MM-DD.md`.
3. A processing marker appended to the raw daily file by the deterministic rollup
   finalizer, not by the model.

## Layout & types (from schema.json)

| What                              | Folder                           | type            |
| --------------------------------- | -------------------------------- | --------------- |
| Raw transcript (read-only log)    | `daily/YYYY-MM-DD.md`            | — (not a card)  |
| Daily summary                     | `summaries/daily/YYYY-MM-DD.md`  | `daily-summary` |
| Weekly / monthly / yearly summary | `weekly/`, `monthly/`, `yearly/` | `*-summary`     |
| Knowledge note / thought          | `cards/notes/`                   | `note`          |
| Person / org                      | `cards/contacts/`                | `contact`       |
| Project                           | `cards/projects/`                | `project`       |
| Idea / proposal                   | `cards/ideas/`                   | `idea`          |
| Decision                          | `cards/decisions/`               | `decision`      |

This table is the stock schema, not a closed ontology. A vault may define additional
entity types through `schema.json` → `node_types` plus `card_type_dirs` (for example,
`commitment` → `commitments`). Use their descriptions and status enums. Most custom
types use `write_card`; `commitment` is special because its lifecycle is owned by
`write_commitment`. Summary types still belong only to the rollup.

### Commitment contract (only when schema enables `commitment`)

Every explicit promise or obligation that has an owner, a deliverable, and a due date
MUST become a commitment card through `write_commitment`. It is not enough to mention it
in a contact/project card or only in the daily summary.

- `create` when the promise is made;
- `reschedule` when its due date changes;
- `complete` when delivery is explicitly confirmed;
- `cancel` when the obligation is explicitly withdrawn;
- `noop` only when the exact state is already stored.

Reuse the same stable, descriptive `commitment_id` for every transition (for example,
`ivan-petrov-nordsupply-api-access`). The tool owns `status`, current truth, provenance,
and append-only `## History`; never use generic `write_card` for a commitment lifecycle
change. An Iva opinion or inference is never a commitment and must not be materialized as
one. Requests without an accepted promise stay in the transcript unless another source
explicitly establishes the obligation.

Always pick `type` and `status` from `schema.json` → `node_types`. Never invent a status.

## Flow (4 phases)

1. **CAPTURE** (`phases/capture.md`) — read the transcript, segment it, and decide
   what is noteworthy: which entities, decisions, ideas, and topics the day produced.
2. **PROCESS** (`phases/process.md`) — materialize schema-enabled commitments through
   their lifecycle tool; create / update other cards by choosing exactly one
   `ADD | UPDATE | SUPERSEDE | NOOP` operation, then type + description-snippet + tags +
   status; dedup against existing cards.
3. **LINK** (`phases/link.md`) — wire every new card to its domain hub + 2–3 neighbors.
4. **SUMMARIZE** (`phases/summarize.md`) — write the daily-summary card: the day's
   TOPICS plus a MOC linking up to the week, down to the created cards, and down to
   the raw daily transcript. Return the semantic report; the rollup finalizer owns
   all mechanical work.

## Mechanical finalization

Do not run autograph commands and do not append the processing marker. After the model
turn returns, `scripts/memory/rollup.ts` runs a deterministic finalizer that:

1. validates or adds the required daily-summary frontmatter;
2. runs cleanup, schema enforcement, graph repair, touch, MOC generation, decay, and
   graph health in a fixed order;
3. verifies that the graph artifact exists;
4. appends the processing marker only after every command succeeds.

Before the model turn, the same code runs the deterministic supersede scan, so
`.graph/supersede-candidates.json` is always present when the PROCESS phase reads it.
A failed mechanical command fails the rollup and leaves the day unmarked for a safe retry.

## Hard rules

- **Never modify the raw transcript.** The deterministic rollup finalizer appends the
  processing marker after your turn succeeds.
- **No orphans.** Every card created here must link to a hub and ≥2 neighbors before
  you finish (`phases/link.md`).
- **description is a search snippet, not the title.** One line, what/why, ~150 chars.
- **tags:** 2–5, lowercase, kebab-case.
- **Idempotent.** If the daily file already carries a processing marker and a
  `summaries/daily/YYYY-MM-DD.md` exists, only reconcile new entries; do not duplicate cards.
- **One structure per card.** Exactly one `## Log` and one `## Related`; never emit
  dated `## Обновление` / `## Update` headings. Pass relations only through the
  `write_card.related` argument, never inside `body`.
- **Commitments are tool-owned state.** If `schema.json` enables `commitment`, reread
  `cards/commitments/` before each lifecycle transition and use `write_commitment`.
  Never edit those cards with `write_file` or generic `write_card`.
- **Verify writes.** Reread every created or updated card before finishing. Confirm
  one Log, one Related, no empty/dated update headings, and that Compiled Truth says
  what is true now. A failed invariant keeps the rollup unfinished.
- **Quiet days are fine.** No noteworthy entities → still write a short daily-summary
  with topics and the MOC down to the raw transcript. Do not manufacture cards.

## References

- `references/classification.md` — what becomes a card vs. stays in the transcript.
- `references/card-templates.md` — frontmatter templates per type.
- `references/linking.md` — hub + neighbor linking protocol.
- `references/daily-summary.md` — the daily-summary card spec (topics + MOC).
- `scripts/autograph/docs/SKILL.md` — the typed vault engine (graph, decay, MOC, dedup).
- `scripts/memory/instructions/rules/{daily,weekly,monthly,yearly}-format.md` — format +
  rollup chain navigation rules.
