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
| Local proof (not in git) | `.cursor/skills/verify-grok/artifacts/<run-id>/` |

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

- Default (the only accepted evidence root): `.cursor/skills/verify-grok/artifacts/<GROK_VERIFY_RUN_ID>/<feature>/`
- Ignore rules: repo `.gitignore` + `.cursor/skills/verify-grok/.gitignore` still cover `artifacts/`, `proof/`, and similar run evidence. `proof/` stays gitignored; the harness does not write or accept it.

## Behavior change (adversarial-review remedies)

- `themes list`, `themes scores`, `smoke check`, and `doctor` require present state-dir copies. They never fall back to live `REPO_ROOT` files. After `cleanup` (or if copies are missing), those commands fail closed.
- `themes scores` is no longer an inline Python re-import. It calls `rtf_themes.py --format scores`. Empty-table exit codes match `list` / `count` (non-zero when zero rows).

## Last proven (this review-fix pass)

Re-run after removing live fallback and the second scores path (REVIEW_FIX_RUN_ID=20260915T221955Z-2178):

```text
eval "$(… launch)" then doctor / themes list / themes scores / smoke check → ok
doctor → ok, theme_count=25, paths under /tmp/grok-verify-<id>/
themes scores → {theme, previous_score} only via rtf_themes.py --format scores; Agentic AI Systems = N/A
empty table → scores/list/count/json/tsv all exit 1
cleanup → state removed; themes list|scores and smoke check fail closed
  (error: … copy missing in state dir …; no live THEMES.md / CLOUD_AGENT_SMOKE.md read)
```

Do not paste large proof JSON into this file; open the local artifacts path above.

## PR

- Branch: `cursor/verify-grok-review-fixes-00de`
- PR: https://github.com/ixefKos/Grok/pull/4
- Do not merge from agents unless a human explicitly asks.
