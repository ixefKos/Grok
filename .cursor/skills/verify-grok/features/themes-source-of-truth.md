# Themes source of truth

Themes source of truth lets a user (or Grok harvester agent) read every theme row from `THEMES.md` and treat that table as the sole Previous Score input for scoring updates.

## Sub-features

- `themes-parse` extracts Theme Name, Previous Score, and Tier Classification from the document.
- `themes-rtf` succeeds when `THEMES.md` is RTF-wrapped Markdown, not only plain Markdown.
- `themes-count` reports a stable row count for doctor and regression checks.
- `themes-known-row` confirms a known high-tier theme is present with the expected score.

## How to get to it (user POV)

- Open `THEMES.md` and read the section `CURRENT THEMES SCORING TABLE (Source of Truth)`.
- Run the IRA Harvester update instructions that tell Grok to extract all themes and previous scores from that table.
- Run `control-grok themes list` after a verification launch.

## Driving it with control-grok

Preconditions:

- `eval "$(.cursor/skills/verify-grok/helpers/control-grok launch)"` has been run.
- `control-grok doctor` prints `ok` with `theme_count` ≥ 20.

- **Parse table.** List all themes as JSON. Run `control-grok themes list`. Exit code `0`. Stdout is a JSON array; each object has `theme`, `previous_score`, and `tier`.
- **Count rows.** Run `control-grok themes list count`. Exit code `0`. Stdout is an integer ≥ 20 (currently 25).
- **Known row.** From the JSON list, confirm an object with `theme` equal to `AI Semiconductor & Compute Infrastructure` and `previous_score` equal to `97`.
- **TSV view.** Run `control-grok themes list tsv`. Exit code `0`. Stdout contains a line starting with `Circular Economy Tech` and score `49`.
- **Proof.** Save the JSON list. Run `control-grok themes list | control-grok evidence write themes-source themes.json`. The file exists under `artifacts/<run-id>/themes-source/themes.json` and still lists both known themes after `control-grok cleanup`.

## Gotchas

- `THEMES.md` may be Rich Text Format even though the extension is `.md`. Do not require a plain-text `file` result.
- Surrogate/emoji tier markers in the RTF source must not crash the parser; tier text may still contain non-ASCII symbols.
- Counting lines in the raw RTF file is not proof. Use `control-grok themes list`.
- Doctor alone is insufficient proof of a known row. Assert the named theme and score.
