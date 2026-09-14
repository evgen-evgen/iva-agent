# Phase 4: SUMMARIZE

Write the daily-summary card — the day's node in the rollup chain. The deterministic
rollup finalizer validates the summary, runs autograph, and marks the transcript processed
after you return. Do not perform those mechanical steps yourself.

Full template + MOC contract: `references/daily-summary.md` and
`scripts/memory/instructions/rules/daily-format.md`.

## 1. Write `summaries/daily/YYYY-MM-DD.md`

```markdown
---
type: daily-summary
date: YYYY-MM-DD
description: >-
  One-line gist of the day — what happened and why it mattered.
tags: [daily, <topic-tag>, <topic-tag>]
status: active
topics: [topic-a, topic-b, topic-c]
source: daily/YYYY-MM-DD.md
---

# YYYY-MM-DD

## Topics

- **Topic A** — one line.
- **Topic B** — one line.

## Highlights

- What actually happened / was decided / was learned.

## Cards created today

<!-- MOC down → the cards from Phase 2/3 -->

- [[cards/decisions/2026-06-20-systemd-timers|Use systemd timers for rollups]]
- [[cards/ideas/layered-memory-with-decay|Layered memory with decay]]

## Navigation

<!-- Rollup chain: down to the raw transcript, up to the week -->

- Raw transcript: [[daily/YYYY-MM-DD|Full transcript]]
- Up: [[weekly/YYYY-Www|Week WW]]
```

### MOC contract (must hold)

- **Down to cards** — every card created/updated today is linked under
  `## Cards created today`.
- **Down to raw** — `## Navigation` links the raw transcript `daily/YYYY-MM-DD.md`.
- **Up to week** — `## Navigation` links the parent `weekly/YYYY-Www.md` (the file the
  weekly rollup will create/maintain). Link it even if it does not exist yet.
- `topics:` frontmatter holds the day's topic labels (also surfaced under `## Topics`).

Quiet day → keep `## Topics` and `## Navigation`; `## Cards created today` may say
`- (none)`.

## 2. Hand back

Return a compact result for the rollup script to report to Telegram: date, topics, and
count of cards created/updated. Do not append a processing marker and do not run autograph
commands. The rollup finalizer owns those steps and will fail the run if they do not
complete.
