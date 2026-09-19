# Linking protocol

Every schema card is indexed by a generated domain MOC. Model-authored relations are for
real semantic neighbors only, never placeholders or quota-filling links.

## 1. Hub (domain index)

Resolve domain from path via schema `domain_inference`:

| Path               | domain    | generated hub          |
| ------------------ | --------- | ---------------------- |
| `cards/projects/`  | work      | `MOC/MOC-work.md`      |
| `cards/decisions/` | work      | `MOC/MOC-work.md`      |
| `cards/contacts/`  | personal  | `MOC/MOC-personal.md`  |
| `cards/notes/`     | knowledge | `MOC/MOC-knowledge.md` |
| `cards/ideas/`     | knowledge | `MOC/MOC-knowledge.md` |

`uv run scripts/autograph/moc.py generate vault vault/schema.json` creates these hubs and
adds their links down to cards after the model turn. Do not put a speculative hub link in
the card itself, and never link `cards/*/_index`: Iva does not generate those files.

## 2. Neighbors

Find genuinely related existing cards. There is no minimum count; zero is better than a
false or broken edge.

```bash
grep -rl "type: <type>" vault/cards/<kind>/
uv run scripts/autograph/graph.py backlinks vault cards/<kind>/<file> vault/schema.json
```

Link only relevant existing neighbors, each with a context phrase explaining the
relationship:

```markdown
## Related

- [[cards/projects/iva-memory|Iva memory]] — this decision picks its scheduler
- [[cards/notes/deepgram-nova3-multi|Deepgram nova-3 multi]] — feeds the same pipeline
```

## 3. Reciprocity

If A strongly relates to B, add the reverse link on B too. Keep the graph navigable in
both directions.

## 4. Touch & verify

```bash
uv run scripts/autograph/engine.py touch vault/cards/<kind>/<file>.md
uv run scripts/autograph/graph.py health vault vault/schema.json   # broken links should be 0
```

## Wiki-link form (Obsidian)

- `[[path/to/card|Display Text]]` — path is vault-relative, no `.md`.
- Inside tables, escape the pipe: `[[path\|Display]]`.
- See `scripts/autograph/docs/references/` for the autograph formatting references.
