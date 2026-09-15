# Theme tier labels

Theme tier labels let a user see which opportunity tier each theme currently carries in the scoring table (Immediate Opportunity through Watch List).

## Sub-features

- `tier-read` returns the Tier Classification string with each theme via `themes list`.
- `tier-known` confirms known themes land in expected tier text families.
- `tier-stability` checks that tier text is present for every row (non-empty).

## How to get to it (user POV)

- Open `THEMES.md` and read the Tier Classification column in the scoring table.
- Run `control-grok themes list` and inspect each object’s `tier` field.

## Driving it with control-grok

Preconditions:

- Verification launch and `control-grok doctor` succeeded.

- **Read tiers.** Run `control-grok themes list`. Exit code `0`. Every object has a non-empty `tier` string.
- **Tier 1 sample.** Confirm `AI Semiconductor & Compute Infrastructure` has a `tier` containing `TIER 1`.
- **Watch list sample.** Confirm `Metamaterials` has a `tier` containing `TIER 4`.
- **Proof.** Save the JSON list. Run `control-grok themes list | control-grok evidence write theme-tiers themes.json`. After cleanup, the artifact still shows both sample tiers.

## Gotchas

- Tier cells may include emoji or other symbols from the RTF source. Assert substring membership (`TIER 1`), not exact full-string equality, unless you normalize symbols first.
- Previous Score and Tier Classification are independent columns; do not infer one from the other in proof.
