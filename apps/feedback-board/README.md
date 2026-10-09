# Feedback board

A private kanban that runs on your computer at `http://127.0.0.1:4173`. It is not a public site. The server listens on `127.0.0.1` only.

Cards live in five columns: Inbox, Todo, In progress, PR, and Done. You can type a card (title and notes) or pull open issues from a private GitHub inbox. Drag a card between columns to file it.

## Setup

Node.js 20 or newer (this was checked on Node 22). From this folder:

```bash
npm i
cp config.example.json config.local.json
npm start
```

Then open `http://127.0.0.1:4173`.

`npm start` builds the page and serves it with the API. `config.local.json` is gitignored. If you skip the copy, the board still starts with the example values: agents off, inbox repo `ixefKos/feedback-inbox`, and a daily cap of 3.

The landing-page preview is `apps/thedailylumen`. From that folder:

```bash
node server.js
```

Open `http://127.0.0.1:4174`.

## What stays off the public repo

This repo is public. These files stay on the machine and are gitignored:

- `data/cards.json` and `data/runs/`
- `config.local.json`
- `.env`

Only `config.example.json` is committed. Do not put tokens in it.

## Inbox contract

Issues filed by the bot routine include two lines in the issue body:

```text
x_author_id: <numeric id>
x_handle: @<handle>
```

`x_author_id` must be its own line: the prefix `x_author_id: `, one space, then digits only. The board drops the issue when that line is missing, when it is not exact, or when the id is `2416162544`. It also drops the issue when the title or body contains `@nanalyzetweets` in any letter case. That handle check is a second layer. The GitHub author field is not used. The blocked handle and the blocked id are public information. They are kept in code on purpose so the filter cannot be turned off by local config.

## Safety

- The board never calls the X API and never posts, replies, likes, or follows.
- The server listens on `127.0.0.1` and answers only when the Host header is `127.0.0.1:<port>` or `localhost:<port>`.
- Refresh reads GitHub issues and pull request state. The only GitHub write is a draft pull request after a run that stays inside the allowed folders.
- Nothing merges a pull request. You merge on GitHub if you want the card to move to Done.
- A drag starts a run only when agents are on, and only when the card is dropped on Todo.
- One run per card. The card locks, and the daily count increments, before the agent process starts. If that process fails to start, the board unlocks the card, decrements the daily count, removes the worktree, and deletes the `feedback/card-<id>` branch so a retry can start.
- One run at a time.
- Daily cap from `dailyCap` (default 3).
- Stop kills the agent process group. Shutting down the server kills it too. No pull request is opened after a stop.
- The work copy must be a separate checkout of `ixefKos/Grok`. The board refuses to start if the path contains `Lumen` (any case). Every URL from `git remote get-url --all origin` and `git remote get-url --push --all origin` must be `ixefKos/Grok`. The same check runs again immediately before the push.
- The run refuses to start when `git config --local --get-regexp` or `git config --worktree --get-regexp` matches `url.*`, `include.*`, or `includeIf.*`, including `insteadOf` and `pushInsteadOf`. A global `insteadOf` key is allowed only when the rewritten origin still resolves to `github.com/ixefKos/Grok`. Otherwise the run is refused and fails closed. Local `insteadOf` and `pushInsteadOf` still apply, so those keys stay rejected. When git reports that `--worktree` cannot be used because the worktree config extension is off, no worktree config is in effect, and that result is not a hit.
- The agent command is `grok -p "<fixed rules + fenced card>" --output-format json --max-turns 40 --always-approve --sandbox strict` plus `--deny` rules. The sandbox profile `strict` limits writes to the worktree. On macOS, strict sandbox mode does not restrict network. Tokens are stripped from the agent environment. The board's own git and gh calls are pinned and checked separately. Deny rules block `git push`, `gh`, `git config`, `git update-ref`, `git checkout`, `git switch`, `git remote`, and writes outside the worktree. The deny list is defence in depth. The kernel sandbox is the main protection. `grokCommand` can point at the executable. The flags stay fixed.
- The child process does not receive `GH_TOKEN`, `GITHUB_TOKEN`, other `GH_*` variables, `GIT_ASKPASS`, or `SSH_AUTH_SOCK`. Its `GH_CONFIG_DIR` is an empty temporary directory.
- Card title and notes are fenced as untrusted data. Nothing inside the fence is a command.
- The fixed rules allow edits only under `apps/thedailylumen/` and `apps/feedback-board/`. They forbid `git push`, `gh`, network posting, and touching anything named Lumen pipeline.
- The server pins `origin/main` to a commit sha before the agent starts. Right after `git worktree add`, it records the worktree git dir from the work copy (`rev-parse --git-common-dir` and `worktree list --porcelain`), never by asking git from inside the worktree. After the process exits, the server checks that `<worktree>/.git` is still a regular file whose text is `gitdir: <recorded git dir>`. If that file is missing, a symlink, a directory, or points somewhere else, the card turns red and no git command runs. Every later git command sets `GIT_DIR` to the recorded dir and `GIT_WORK_TREE` to the worktree, so the worktree `.git` file is not read. The server then checks `git diff --name-only --no-renames <baseSha>..HEAD`, plus uncommitted and untracked files, also with `--no-renames`. A symlink (git mode `120000`) in that changed set is rejected, including one inside an allowed folder. HEAD must be `refs/heads/feedback/card-<id>`. If any path is outside the two allowed folders, or any changed path is a symlink, the card turns red and lists the paths. No commit, push, or pull request happens.
- Every board git command, before and after the agent, passes `-c core.fsmonitor=false`, `-c http.sslVerify=true`, `-c http.proxy=`, `-c core.sshCommand=`, and `-c core.hooksPath=/dev/null`.
- If the paths are inside those folders, the server commits when needed. The commit message is `feedback: card <short-id>`. It does not include the card title or notes. The server checks `<baseSha>..<finalSha>` again, then pushes that sha to `https://github.com/ixefKos/Grok.git` as `refs/heads/feedback/card-<id>`. The board's own commit and push run with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so global and system config do not apply. A global `includeIf` that points into the worktree is ignored for that push. Both commands pass `core.hooksPath=/dev/null`, an empty `credential.helper`, and `credential.https://github.com.helper=!gh auth git-credential` as separate arguments. `user.name` and `user.email` are passed with `-c` from the local repository config, or the defaults `feedback-board` and `feedback-board@localhost`, because global config is off. The draft pull request title is the same neutral line. The body lists the changed files and a run summary only.
- Refresh checks `gh pr view <url> --json state,mergedAt`. A merged pull request moves the card to Done.
- Each run is logged at `data/runs/<id>.log`.

## How to turn agents on

Agents stay off until you edit `config.local.json` and restart the board.

1. Install the Grok Build CLI and sign in with your SuperGrok account.
2. Sign the GitHub CLI in as `ixefKos` (`gh auth status`).
3. Clone `ixefKos/Grok` into a new folder whose path does not contain `Lumen`. Do not point this at a Lumen checkout.
4. In `config.local.json` set `agentsEnabled` to `true` and `workCopyPath` to that folder. Set `grokCommand` if `grok` is not on your `PATH`.
5. Restart `npm start`.
6. Drag a card onto Todo. That starts the one run for that card. With agents still off, the same drag only files the card under Todo and starts nothing.

To start a card that is already sitting in Todo, turn agents on, then drag it onto Todo again.
