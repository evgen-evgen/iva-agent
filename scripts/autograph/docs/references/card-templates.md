# Card Templates

Generic templates. Adapt types/statuses to your schema.json.

## Note

```yaml
---
type: note
description: >-
  [One-line search snippet — what this knowledge is about]
tags: [topic, subtopic]
status: active
source: article
created: 2026-01-01
---
```

## Contact

```yaml
---
type: contact
description: >-
  [Who they are, relationship context]
tags: [network, role]
status: active
---
```

## Project

```yaml
---
type: project
description: >-
  [What the project delivers, for whom]
tags: [client, type]
status: active
---
```

Optional fields on any card: `updated: YYYY-MM-DD` (set when a Compiled-Truth value
changes), `confidence: EXTRACTED | INFERRED | AMBIGUOUS` (certainty of the fact).

## Superseded card (whole card retired)

When an entire card is obsolete (project renamed, decision reverted, entity merged),
don't delete it — mark it and point to the replacement:

```yaml
---
type: project
description: >-
  [Old project, replaced by the new one]
tags: [client, type]
status: superseded
superseded_by: [[new-project-card]]
---
```

## Card with History (a fact changed — see references/update-in-place.md)

Compiled Truth (frontmatter + top of description) is what counts as true now; displaced
facts move to an append-only `## History` section, never edited, one line per displaced
value: `- {YYYY-MM-DD}: {fact}`. Cards written through Iva's `write_card` get this
section from the tool — pass the displaced fact as `history_entry` instead.

```markdown
---
type: contact
description: >-
  Creative director at Globex (since 2026-06)
tags: [network, creative]
status: active
updated: 2026-06-01
---

# Jane Doe

Creative director at Globex.

## History

- 2026-06-01: company: TDI Group (held 2026-03→2026-06)
- 2026-06-01: role: Art Director (held 2026-01→2026-06)
```

## Linking Protocol

После создания файла:

1. **Related:** Добавь только существующие карточки с реальной смысловой связью.
   Если таких пока нет, пустой `## Related` допустим.
2. **Domain MOC:** Запусти `moc.py generate`; он создаст `MOC/MOC-<domain>.md`
   и добавит ссылку на карточку. Не создавай ссылки на несуществующие `_index`.
3. **Touch:** `python3 scripts/autograph/engine.py touch <new-file>`
4. **Verify:** Все ссылки в `## Related` существуют и действительно полезны.

### Checklist

- [ ] Все Related-ссылки существуют?
- [ ] Доменный MOC ссылается на карточку?
- [ ] description ≠ title repeat?
- [ ] tags: 2-5, lowercase, kebab-case?
- [ ] status ∈ schema enum?

## Anti-Patterns

❌ `description: "Contact"` — useless for search, write a real snippet
❌ `status: "interested"` — not in enum, use what your schema defines
❌ `tags: []` — empty tags add nothing, pick 2-5 relevant ones
❌ No frontmatter — every file needs `---` block
❌ Creating a near-duplicate instead of updating — grep/`search.py` first
❌ Two contradictory Compiled Truths on one subject — supersede the old one into `## History`
