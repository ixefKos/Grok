# Previous score extraction

Previous score extraction produces the harvester input shape: every theme name paired with its Previous Score, using `THEMES.md` as the sole source of truth.

## Sub-features

- `scores-extract` emits theme + previous_score for every table row.
- `scores-na` preserves `N/A` scores (for example Agentic AI Systems) instead of dropping them.
- `scores-complete` covers the same row count as `themes list`.

## How to get to it (user POV)

- Follow the Instructions for Grok block in `THEMES.md`: extract ALL themes and previous scores from the table, using it as the sole source of truth for Previous Score.
- Run `control-grok themes scores` after a verification launch.

## Driving it with control-grok

Preconditions:

- Verification launch and `control-grok doctor` succeeded.
- `control-grok themes list count` reports the baseline row count.

- **Extract scores.** Run `control-grok themes scores`. Exit code `0`. Stdout is a JSON array of objects with only `theme` and `previous_score`.
- **Preserve N/A.** Confirm an object with `theme` `Agentic AI Systems` and `previous_score` `N/A`.
- **Match count.** Compare `themes scores` length to `themes list count`. They must be equal.
- **Proof.** Save both views. Run `control-grok themes scores | control-grok evidence write previous-scores scores.json` and `control-grok themes list count | control-grok evidence write previous-scores count.txt`. After cleanup, both artifacts remain and `scores.json` still contains `Agentic AI Systems`.

## Gotchas

- Do not invent previous scores from memory or chat history. Only the themes document counts.
- A full themes list with tiers is not the same as the scores extract; harvester input omits tier.
- `N/A` is a valid previous score string, not a missing row.
