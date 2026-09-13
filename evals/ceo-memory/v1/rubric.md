# CEO memory benchmark rubric

Score each question from `questions.json`:

- **2 — correct:** all required claims are present, no forbidden claim appears, and the answer distinguishes current truth from history when relevant.
- **1 — partial:** the answer is directionally correct but omits a required detail, blurs provenance, or gives an incomplete lifecycle.
- **0 — incorrect:** a required conclusion is wrong, a forbidden claim appears, or the answer is unsupported.

Normalize the sum of question points to 100, then inspect the category profile below. The total is useful for comparison; the critical-error gate determines whether a run is safe enough to pass.

## Category weights

- Current truth — 30 points
- Commitment lifecycle — 25 points
- Temporal history and supersede behavior — 15 points
- Entity resolution and linking — 10 points
- Provenance and confidence — 10 points
- Precision and resistance to hallucination — 10 points

For reporting, compute the mean score within each category and multiply it by that category's weight. This avoids a future benchmark version accidentally overweighting a category merely by adding more questions to it.

## Critical errors

Any of the following is a critical error, even if the wording is fluent:

- reporting 18 September as the current Delta launch date after 10 September;
- reporting the API-access commitment as open after 11 September;
- reporting Marina's proposal or Oleg's cash-flow as overdue after completion;
- omitting Marina's still-open Acme contract commitment when asked for open commitments;
- merging Ivan Petrov with Ivan Sokolov;
- presenting Iva's opinion about NordSupply as an explicit CEO fact or decision;
- claiming that a second supplier was approved or contracted;
- automatically reverting the launch decision because the API blocker was resolved.

## Result bands

- **Pass:** at least 90/100 and zero critical errors.
- **Needs review:** 80–89/100 and zero critical errors.
- **Fail:** below 80/100 or at least one critical error.

## Vault inspection checklist

Answer quality alone can hide a broken memory layout. After each run, inspect the vault and record:

- duplicate cards for the same subject;
- contradictory current truths outside `## History`;
- stale open commitments after completion;
- missing history for changed launch/API/cash-flow deadlines;
- links between Delta, the right people, Acme, and NordSupply;
- cards created from office-color noise;
- EXTRACTED facts sourced only from `[iva]` entries;
- invalid types or statuses rejected by `write_card`;
- orphan cards or broken wiki-links.

The comparison report should show both the answer score and these structural defects. A higher answer score with a dirtier vault is not automatically a better memory system.
