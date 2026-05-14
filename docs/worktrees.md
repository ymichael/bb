# Worktrees and setup scripts

When you start a thread in bb, you can run it in your project's existing
checkout or in a fresh **managed worktree** — a separate working copy on disk
with its own branch. Worktrees let bb work on multiple things in parallel
without touching your main checkout, and they make it easy to throw away
whatever the agent does without affecting the rest of your work.

You can pair a worktree with a **setup script** that bb runs the first time
the worktree is created — useful for installing dependencies, copying a
`.env`, generating secrets, or anything else you need before the agent
starts.

## What is a managed worktree?

A managed worktree is a `git worktree` of your project's repo, on a fresh
branch. Under the hood it's `git worktree add` plus some bookkeeping:

- It shares the repo's `.git` state with your main checkout — cheap to
  create, no full clone.
- It gets its own branch so multiple threads can run in parallel.
- It lives at `<BB_DATA_DIR>/worktrees/<environment-id>/<repo-name>` — for
  example, `~/.bb/worktrees/env_abc.../myrepo`.
- When the owning thread is archived or deleted, bb cleans the worktree up
  (`git worktree remove --force`) along with the branch.

## Start a thread in a worktree

In the app, pick **New worktree** in the environment picker when starting
a thread.

From the CLI:

```bash
pnpm bb thread spawn \
  --project <project-id> \
  --new-environment worktree \
  --prompt "..."
```

Pass `--base-branch <name>` to branch from something other than the project's
default branch.

## Run setup with `.bb-env-setup.sh`

Drop a file named `.bb-env-setup.sh` at the root of your project. If bb finds
one when it creates a worktree, it runs the script inside the new worktree
before handing the thread to the agent.

Use it for anything the agent will need in a fresh checkout — install
dependencies, copy a `.env`, sync local state, generate tokens, etc.

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm install
cp ~/.config/myapp/.env .
```

Contract:

- The script runs with `bash`, working directory set to the new worktree.
- stdin is closed. stdout and stderr stream into the thread's provisioning
  transcript in the app.
- A non-zero exit, a signal, or a timeout (15 minutes) fails provisioning and
  the thread doesn't start.
- POSIX only — supported on macOS, Linux, and WSL2. Native Windows isn't
  supported.

The same script also runs after a managed clone (used by ephemeral cloud
sandbox hosts), so anything you put in `.bb-env-setup.sh` works in both
places.

## Cleanup

You don't need to clean up worktrees by hand — bb removes them when the
owning thread is archived or deleted, and the branch goes with it. If you
want to keep work the agent did, commit and push (or open a PR) from inside
the worktree before letting the thread go.

## If something isn't working

A few quick checks:

1. If worktree creation fails, look at the thread's provisioning transcript
   in the app. Failures from `git worktree add` (dirty source checkout,
   invalid base branch, conflicting branch name) show up there with the exact
   git error.
2. If `.bb-env-setup.sh` doesn't seem to run, make sure it's committed to
   the branch you're working from. A file that exists only in the working
   copy of your main checkout won't appear in the new worktree.
3. If your setup script hangs, remember stdin is closed. Anything that
   prompts for input will time out at 15 minutes.
4. Run `bash .bb-env-setup.sh` manually in a clean clone to verify it works
   outside bb before debugging through the provisioning transcript.
