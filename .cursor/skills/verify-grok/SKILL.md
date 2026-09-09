---
name: verify-grok
description: "Drive and prove the Grok / IRA Harvester document repo — themes source-of-truth parsing, previous-score extraction, and cloud-agent smoke doc checks. Use when verifying changes to THEMES.md, CLOUD_AGENT_SMOKE.md, or harvester input contracts."
---

# Verify Grok (IRA Harvester documents)

This repo has no web UI, CLI product binary, or HTTP service. The user-facing surface is **document workflows**:

1. `THEMES.md` — IRA Harvester themes scoring table (often RTF-wrapped Markdown). Source of truth for Previous Score.
2. `CLOUD_AGENT_SMOKE.md` — Cloud Agent draft-PR smoke checklist.

Drive everything through `control-grok`. Do not hand-edit proof by guessing table rows.

## Launch

From the repo root:

```bash
eval "$(.cursor/skills/verify-grok/helpers/control-grok launch)"
```

Ready when stderr prints `launched verify run <id>` and the shell has `GROK_VERIFY_RUN_ID` and `GROK_VERIFY_STATE_DIR` set. Launch copies `THEMES.md` and `CLOUD_AGENT_SMOKE.md` into an isolated `/tmp/grok-verify-<id>/` so concurrent runs do not share mutable copies.

There is no long-lived server. Each verify run is a disposable state directory plus evidence under `.cursor/skills/verify-grok/artifacts/<run-id>/`.

Teardown:

```bash
control-grok cleanup
```

## Doctor

Whenever anything looks off, run:

```bash
control-grok doctor
```

Require stdout to start with `ok` and report:

- `theme_count` ≥ `GROK_MIN_THEME_COUNT` (default 20)
- `themes` and `smoke` paths under the current `state_dir`
- `evidence_root` pointing at this run’s artifact directory

Refuse to drive a run that was not started by `control-grok launch` for this session.

## Drive

Put helpers on `PATH` (already done by `eval "$(… launch)"`), then:

| Intent | Command |
| --- | --- |
| Health | `control-grok doctor` |
| List themes JSON | `control-grok themes list` |
| List themes TSV | `control-grok themes list tsv` |
| Theme count | `control-grok themes list count` |
| Previous-score extract | `control-grok themes scores` |
| Smoke doc contract | `control-grok smoke check` |
| Write evidence | `control-grok evidence write <feature> <filename>` (stdin or trailing args) |
| Cleanup | `control-grok cleanup` |

Stable handles for this repo:

- File paths: `THEMES.md`, `CLOUD_AGENT_SMOKE.md`
- Themes table columns: Theme Name, Previous Score, Tier Classification
- Smoke H1: `# Cloud Agent Smoke`
- Expected themes include `AI Semiconductor & Compute Infrastructure` (score `97`) and `Circular Economy Tech` (score `49`)

Read `.cursor/skills/verify-grok/features/` before picking a recipe. Drive the entry points listed there; do not invent alternate parsers mid-proof.

## Evidence

Proof lives under:

`.cursor/skills/verify-grok/artifacts/<GROK_VERIFY_RUN_ID>/<feature>/`

Standards:

- Exercise the real user path: parse the themes document and the smoke document as an agent/harvester would, not a hand-built fixture unrelated to those files.
- Capture the action and the resulting state (command + stdout JSON/TSV + exit code), not only a final summary.
- For themes mutations on the disposable copy, re-read with `themes list` / `themes scores` to confirm the stored table. Do not treat an edit as proven without a second read.
- Never mock `THEMES.md` contents for a themes proof; the disposable copy must originate from the repo file via `launch`.
- Record the feature ID in the evidence path (`artifacts/<run>/<feature>/…`).

Suggested filenames: `doctor.txt`, `themes.json`, `scores.json`, `smoke.txt`, `transcript.txt`.

## Cleanup

```bash
control-grok cleanup
```

Removes only `/tmp/grok-verify-<id>/` (the disposable state). **Does not** delete `.cursor/skills/verify-grok/artifacts/<id>/`. Kill nothing by process name; this harness starts no daemons.

After cleanup, confirm evidence still exists at `artifacts/<run-id>/`.

## Helpers

Executable scripts in `.cursor/skills/verify-grok/helpers/`:

- `control-grok` — launch / doctor / themes / smoke / evidence / cleanup
- `rtf_themes.py` — RTF-aware themes table parser (used by `control-grok`)

Invocation examples:

```bash
eval "$(.cursor/skills/verify-grok/helpers/control-grok launch)"
control-grok doctor
control-grok themes list | control-grok evidence write themes-source themes.json
control-grok cleanup
```

## Isolate

Two runs may execute side by side: each gets its own `GROK_VERIFY_RUN_ID`, state dir, and evidence dir. Never drive or mutate the live workspace copies during verification; use the state dir copies. Do not drive another agent’s run ID.

## Feature map

See [features/README.md](./features/README.md).
