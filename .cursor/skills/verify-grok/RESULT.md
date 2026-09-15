# verify-grok — RESULT (for the next agent)

Outer Loop / human-merge packet for the verify-grok skill. Proof stays on disk (gitignored); do not commit `artifacts/` or `proof/`.

## Package shape

| Piece | Path |
| --- | --- |
| Skill body (Launch / Doctor / Drive / Evidence / Cleanup / Helpers) | `.cursor/skills/verify-grok/SKILL.md` |
| Harness | `.cursor/skills/verify-grok/helpers/control-grok` |
| RTF themes parser | `.cursor/skills/verify-grok/helpers/rtf_themes.py` |
| Feature map | `.cursor/skills/verify-grok/features/` |
| This handoff | `.cursor/skills/verify-grok/RESULT.md` |
| Local proof (not in git) | `.cursor/skills/verify-grok/artifacts/<run-id>/` or `proof/` |

## Launch / doctor / drive

From repo root:

```bash
eval "$(.cursor/skills/verify-grok/helpers/control-grok launch)"
control-grok doctor
# expect stdout starting with: ok
# expect theme_count >= 20 (currently 25)

control-grok themes list | control-grok evidence write themes-source themes.json
control-grok themes scores | control-grok evidence write previous-scores scores.json
control-grok smoke check | control-grok evidence write cloud-agent-smoke smoke.txt
# smoke expect: ok smoke_doc=<state-dir>/CLOUD_AGENT_SMOKE.md

control-grok cleanup
# state /tmp/grok-verify-<id> removed; artifacts/<run-id>/ retained on disk
```

Known ok signals:

- `doctor` → `ok` and `theme_count=25` (or ≥ 20)
- `themes list` → JSON rows; `AI Semiconductor & Compute Infrastructure` score `97`
- `themes scores` → `{theme, previous_score}` only; `Agentic AI Systems` = `N/A`
- `smoke check` → `ok smoke_doc=...`

## Where local proof lands

- Default: `.cursor/skills/verify-grok/artifacts/<GROK_VERIFY_RUN_ID>/<feature>/`
- Ignore rules: repo `.gitignore` + `.cursor/skills/verify-grok/.gitignore` cover `artifacts/`, `proof/`, and similar run evidence.

## Last proven (this harden pass)

Re-run after stripping committed blobs (HARDEN_RUN_ID=20260915T220853Z-1942):

```text
control-grok doctor → ok, theme_count=25
themes-source → themes.json written under artifacts/<run-id>/themes-source/
cleanup → state removed; evidence directory still present on disk
git check-ignore -v .cursor/skills/verify-grok/artifacts/<run-id>/themes-source/themes.json → ignored
```

Do not paste large proof JSON into this file; open the local artifacts path above.

## PR

- Branch: `cursor/verify-grok-skill-3bee`
- PR: https://github.com/ixefKos/Grok/pull/2
- Do not merge from agents unless a human explicitly asks.
