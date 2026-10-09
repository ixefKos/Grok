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
- One run per card. The card locks, and the daily count increments, before the agent process starts. If that process fails to start, the board unlocks the card, decrements the daily count, removes the worktree, deletes the `feedback/card-<id>` branch, and prunes stale worktree entries so a retry can start. If that cleanup command fails, the card says `Could not clean up the worktree.`
- One run at a time.
- Daily cap from `dailyCap` (default 3).
- Stop kills the agent process group. Shutting down the server kills it too. No pull request is opened after a stop.
- The work copy must be a separate checkout of `ixefKos/Grok`. The board refuses to start if the path contains `Lumen` (any case). It also refuses when the real path of the work copy, or of a worktree, is under the system temp directory, `/tmp`, `/private/tmp`, `/var/tmp`, `/var/folders`, or `~/.grok`. Every URL from `git remote get-url --all origin` and `git remote get-url --push --all origin` must be `ixefKos/Grok`. The same check runs again immediately before the push.
- The run refuses to start when `git config --local --get-regexp` or `git config --worktree --get-regexp` matches `url.*`, `include.*`, or `includeIf.*`, including `insteadOf` and `pushInsteadOf`. A global `insteadOf` key is allowed only when the rewritten origin still resolves to `github.com/ixefKos/Grok`. Otherwise the run is refused and fails closed. Local `insteadOf` and `pushInsteadOf` still apply, so those keys stay rejected. When git reports that `--worktree` cannot be used because the worktree config extension is off, no worktree config is in effect, and that result is not a hit.
- The agent command is `grok -p "<fixed rules + fenced card>" --output-format json --max-turns 40 --always-approve --sandbox strict` plus `--deny` rules. The sandbox profile `strict` limits writes to the worktree. On macOS, strict sandbox mode does not restrict network, so network exfiltration of the agent's own auth is inherent. A scoped or short-lived grok key for runs is preferred. The agent environment is an allowlist: `PATH`, `LANG`, `LC_*`, `TERM`, `TZ`, `USER`, `SHELL`, the board's private `HOME`, `TMPDIR`, and `GROK_HOME`, and the per-run marker. Nothing else is passed, including `XAI_API_KEY`. The board's own git and gh calls are pinned and checked separately. Deny rules block `git push`, `gh`, `git config`, `git update-ref`, `git checkout`, `git switch`, `git remote`, and writes outside the worktree. The deny list is defence in depth. The kernel sandbox is the main protection. `grokCommand` can point at the executable. The flags stay fixed.
- The child process receives only that allowlist. `XAI_API_KEY` is not passed. Grok sign-in comes from `~/.grok/auth.json`, which the board copies read-only into the private home when that file is present. If `XAI_API_KEY` is set and `auth.json` is missing, the run has no grok credentials: `auth.json` is required.
- Card title and notes are fenced as untrusted data. Nothing inside the fence is a command.
- The fixed rules allow edits only under `apps/thedailylumen/` and `apps/feedback-board/`. They forbid `git push`, `gh`, network posting, and touching anything named Lumen pipeline.
- The server pins `origin/main` to a commit sha before the agent starts. The agent runs in its own worktree. After that process exits, the board does not run git in the agent worktree again. It walks the tree with `lstat` and does not follow links. It accepts only regular files under `apps/thedailylumen/` and `apps/feedback-board/`, and it compares their bytes with the blobs of the pinned base sha. Those blobs are read from the board-owned work copy with `git cat-file`, not from the agent tree. The card turns red, and no commit or pull request is opened, if the walk finds a symlink, any `.git` file or directory other than the worktree's own gitdir file, a socket, fifo, or device, a file over 2 MB, a `.gitattributes` or `.gitmodules` file, more than 200 files in the allowed folders, or a file-list difference outside those folders (`git ls-tree -r --name-only <baseSha>` from the work copy). Deletions inside the allowed folders are kept. Before it commits, the board scans every file it is about to publish. It refuses the publish when a file contains a credential pattern, a secret value of 20 or more characters taken from an auth.json field whose name refers to a token, key, secret, password, or credential, or a dropped environment value of 20 or more characters whose name ends in `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, or `CREDENTIAL`, or starts with `AWS_`. A secret-named parent in auth.json applies to nested values, such as `credentials.default`. Base64 of those values is checked at each 3-byte alignment, in standard and URL-safe form. The hyphen and underscore count as a token boundary only for `sk-`. The card's run status becomes `credential_refused`. The message names the pattern and the file index. It does not record the matched value. The board then deletes the agent worktree on disk, prunes the worktree list, and creates a fresh worktree at the base sha next to the work copy (not in the system temp directory). The agent never touches that fresh worktree. The board copies the accepted files in, applies the deletions, and only then runs the diff gate, commit, and push there. Those commands set `GIT_DIR` and `GIT_WORK_TREE` to the fresh worktree, so its `.git` file is not trusted if it changes. HEAD must be `refs/heads/feedback/card-<id>`. A symlink (git mode `120000`) or a submodule (git mode `160000`) in the fresh diff is rejected. If any gated path is outside the two allowed folders, the card turns red and lists the paths. Afterwards the board removes the fresh worktree with `git worktree remove`, checks that exit code, and runs `git worktree prune`.
- Every board git command passes `-c core.fsmonitor=false`, `-c http.sslVerify=true`, `-c http.proxy=`, `-c core.sshCommand=`, `-c core.hooksPath=/dev/null`, `-c diff.ignoreSubmodules=all`, `-c status.submoduleSummary=false`, and `-c submodule.recurse=false`. Diff and status commands also pass `--ignore-submodules=all`.
- If the paths are inside those folders, the server commits when needed. The commit message is `feedback: card <short-id>`. It does not include the card title or notes. The server checks `<baseSha>..<finalSha>` again, then pushes that sha to `https://github.com/ixefKos/Grok.git` as `refs/heads/feedback/card-<id>`. The board's own commit and push run with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so global and system config do not apply. A global `includeIf` that points into the worktree is ignored for that push. Both commands pass `core.hooksPath=/dev/null`, an empty `credential.helper`, and `credential.https://github.com.helper=!gh auth git-credential` as separate arguments. `user.name` and `user.email` are passed with `-c` from the local repository config, or the defaults `feedback-board` and `feedback-board@localhost`, because global config is off. The draft pull request title is the same neutral line. The body lists the changed files and a run summary only. `gh pr create` still runs git in its current directory: `git remote -v`, `git config --get-regexp` for `remote.*.gh-resolved`, and `git config --get-regexp` for `branch.<head>.(remote|merge|pushremote|gh-merge-base)`. The board runs that command with its cwd, `GIT_DIR`, and `GIT_WORK_TREE` set to the fresh worktree, and with `--repo ixefKos/Grok`, `--base main`, and `--head feedback/card-<id>`, so those git commands do not read the agent tree.
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
