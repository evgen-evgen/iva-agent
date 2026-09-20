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

A commitment's identity is the pair **accountable owner + independently observable
deliverable**. Keep adjacent steps separate when either differs. In particular, a
supplier delivering credentials and an employee verifying that the credentials work are
two commitments, even when they belong to one API-access dependency:

- NordSupply → provide credentials by 10:00;
- Ivan Petrov → verify working API access.

Never copy one party's deadline onto another party. Complete only the card whose owner
and deliverable match the confirmation.

- `create` when the promise is made;
- `reschedule` when its due date changes;
- `complete` when delivery is explicitly confirmed;
- `cancel` when the obligation is explicitly withdrawn;
- `noop` only when the exact state is already stored.

Reuse the same stable, descriptive `commitment_id` for every transition (for example,
`ivan-petrov-nordsupply-api-access`). The tool owns `status`, current truth, provenance,
and append-only `## History`; never use generic `write_card` for a commitment lifecycle
change. An Iva opinion or inference is never a commitment and must not be materialized as
one. A project milestone, SLA/commercial term, or unaccepted request is not itself a
commitment. Requests without an accepted promise stay in the transcript unless another
source explicitly establishes the obligation. Before describing delivery as on time or
late, compare the card's `completed_at` with `due_at`; if either is not precise enough,
state that timeliness is unknown.

Always pick `type` and `status` from `schema.json` → `node_types`. Never invent a status.

### One owner for current truth

Keep each operational fact authoritative in exactly one place:

- a commitment card owns its accountable owner, deliverable, due date, lifecycle status,
  completion time, and lifecycle history;
- a project card owns current project scalars such as launch date, project owner, and
  active blocker;
- a contact card owns stable identity, organization, and role—not copied project dates or
  commitment lifecycle state;
- a decision card records one decision event and its rationale. Search by project,
  subject, and decision date before `ADD`; a wording variant or replay must reuse the
  canonical card, not create a second decision.

Summaries and neighboring cards may link to the authority and describe its impact, but
must not maintain a competing copy of mutable current truth. If a commitment changes,
transition only its commitment card; if a project scalar changes, supersede it only in
the project card and preserve the previous value in that card's `## History`.

## Flow (4 phases)

1. **CAPTURE** (`phases/capture.md`) — read the transcript, segment it, and decide
   what is noteworthy: which entities, decisions, ideas, and topics the day produced.
2. **PROCESS** (`phases/process.md`) — materialize schema-enabled commitments through
   their lifecycle tool; create / update other cards by choosing exactly one
   `ADD | UPDATE | SUPERSEDE | NOOP` operation, then type + description-snippet + tags +
   status; dedup against existing cards.
3. **LINK** (`phases/link.md`) — add only real semantic links to existing neighboring
   cards. The deterministic MOC pass indexes every card by domain.
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
- **No invented links.** Relate a card only to existing cards that have a genuine
  semantic connection. The deterministic finalizer generates domain MOCs and makes every
  schema card reachable even when no suitable neighbor exists yet (`phases/link.md`).
- **description is a search snippet, not the title.** One line, what/why, ~150 chars.
- **tags:** 2–5, lowercase, kebab-case.
- **Idempotent.** If the daily file already carries a processing marker and a
  `summaries/daily/YYYY-MM-DD.md` exists, only reconcile new entries; do not duplicate cards.
  A replayed `ADD` refusal means the canonical card already exists: reread it and choose
  `NOOP` or the real lifecycle transition. Never evade the refusal with a new title.
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
