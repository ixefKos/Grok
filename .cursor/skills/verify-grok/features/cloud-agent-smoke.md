# Cloud agent smoke doc

The cloud agent smoke doc tells a Cursor Cloud Agent how to prove branch, commit, push, and draft-PR mechanics by changing only `CLOUD_AGENT_SMOKE.md`.

## Sub-features

- `smoke-heading` requires the H1 `# Cloud Agent Smoke`.
- `smoke-purpose` states that the file exists so a Cloud Agent can open a draft PR that adds only this document.
- `smoke-check-line` includes the `Smoke check:` success criteria wording.

## How to get to it (user POV)

- Open `CLOUD_AGENT_SMOKE.md` at the repository root.
- Ask a Cloud Agent to perform the smoke check described in that file.

## Driving it with control-grok

Preconditions:

- Verification launch and `control-grok doctor` succeeded.

- **Contract check.** Run `control-grok smoke check`. Exit code `0`. Stdout contains `ok smoke_doc=` and a path under the state directory.
- **Heading proof.** From the state copy, confirm the first Markdown heading is `# Cloud Agent Smoke` (for example `head -n 1 "$GROK_VERIFY_STATE_DIR/CLOUD_AGENT_SMOKE.md"`).
- **Wording proof.** Confirm the file contains `draft pull request` and `Smoke check:`.
- **Proof.** Save the check output. Run `control-grok smoke check | control-grok evidence write cloud-agent-smoke smoke.txt` and `head -n 5 "$GROK_VERIFY_STATE_DIR/CLOUD_AGENT_SMOKE.md" | control-grok evidence write cloud-agent-smoke heading.txt`. After cleanup, both artifacts remain.

## Gotchas

- This feature verifies the **document contract**, not that a live draft PR was opened. Opening a PR is a separate git/PR workflow.
- Doctor already greps some smoke wording; still run `smoke check` and capture evidence for this feature ID.
- Do not mutate the workspace `CLOUD_AGENT_SMOKE.md` during verification; use the state copy.
