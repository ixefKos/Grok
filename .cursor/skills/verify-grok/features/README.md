# Grok verification map

This directory is the maintained source for verifying the user-facing document workflows in the Grok / IRA Harvester repo. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run `eval "$(.cursor/skills/verify-grok/helpers/control-grok launch)"` so `GROK_VERIFY_RUN_ID` and `GROK_VERIFY_STATE_DIR` are set.
- Disposable state contains copies of `THEMES.md` and `CLOUD_AGENT_SMOKE.md`.
- `control-grok` is on `PATH`.
- Run `control-grok doctor` and require `ok`, `theme_count` ≥ 20, and paths under the state directory.
- Never drive a run that was not started by this verification launch.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep file names and flags unchanged.
- Prefer `control-grok` subcommands over ad-hoc Python one-liners.
- Write proof with `control-grok evidence write <feature> <file>`.
- Cleanup with `control-grok cleanup`. Do not remove proof artifacts.

## Proof and skip reporting

- Capture the command, stdout, stderr, and exit code for each step.
- Themes proof includes both a full list (`themes list`) and a second view (`themes scores` or a targeted grep of a known theme).
- Smoke proof includes the `smoke check` output and a copy of the validated heading lines.
- Record the feature ID in the evidence directory name.
- Report an unreachable path with the attempted command and unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-grok`
4. `Gotchas`

## Features

- [Themes source of truth](./themes-source-of-truth.md) covers parsing the scoring table from `THEMES.md`, including RTF-wrapped content.
- [Previous score extraction](./previous-score-extraction.md) covers the harvester input shape: every theme with its Previous Score.
- [Cloud agent smoke doc](./cloud-agent-smoke.md) covers the draft-PR smoke document contract.
- [Theme tier labels](./theme-tier-labels.md) covers observing Tier Classification values on known themes.
