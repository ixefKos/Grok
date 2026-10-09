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

## Safety

- The board never calls the X API and never posts, replies, likes, or follows.
- Refresh reads GitHub issues and pull request state. The only GitHub write is a draft pull request after a run that stays inside the allowed folders.
- Nothing merges a pull request. You merge on GitHub if you want the card to move to Done.
- A drag starts a run only when agents are on, and only when the card is dropped on Todo.
- One run per card. The card locks when the run starts.
- One run at a time.
- Daily cap from `dailyCap` (default 3).
- Stop kills that run. No pull request is opened after a stop.
- The work copy must be a separate checkout of `ixefKos/Grok`. The board refuses to start if `git remote get-url origin` is not `ixefKos/Grok`, or if the work copy path contains `Lumen` (any case).
- The run command is `grok -p "<fixed rules + card text>" --output-format json --max-turns 40 --always-approve`. `grokCommand` in the local config can point at that executable. The flags stay fixed.
- The fixed rules allow edits only under `apps/thedailylumen/` and `apps/feedback-board/`. They forbid `git push`, `gh`, network posting, and touching anything named Lumen pipeline.
- After the process exits, the server (not the agent) checks `git diff --name-only origin/main...HEAD`, uncommitted edits, and untracked files. If any path is outside those two folders, the card turns red and lists the paths. No commit, push, or pull request happens.
- If the paths are inside those folders, the server commits when needed, pushes `feedback/card-<id>`, and opens a draft pull request. The card moves to PR.
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
