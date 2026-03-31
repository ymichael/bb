# `workspace.squash_merge` — Squash-merge current branch into target (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:218-221`
**Handler:** `apps/host-daemon/src/command-handlers/workspace.ts:5-17`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:323-326`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field                   | Required | Notes                                                                                                                                                                                            |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `environmentId`         | Yes      | Identifies the runtime entry.                                                                                                                                                                    |
| ~~`environmentStatus`~~ | ~~Yes~~  | Removed — no longer part of the command payload.                                                                                                                                                 |
| `workspaceContext`      | Yes      | Object with `workspacePath` and `workspaceProvisionType`. Replaces flat `workspacePath`. Used by `requireWorkspaceEnvironment` for lazy re-provisioning with the correct managed/unmanaged type. |
| `targetBranch`          | Yes      | The branch to squash-merge into (e.g., `main`).                                                                                                                                                  |
| `commitMessage`         | Yes      | Server-generated commit message for the squash commit. Min 1 char.                                                                                                                               |

**All fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` delegates to `squashMerge(command, runtimeManager)`.
2. `squashMerge` (workspace.ts:5-17): calls `requireWorkspaceEnvironment`, then `entry.workspace.squashMergeInto({ targetBranch, commitMessage })`.
3. `WorkspaceImpl.squashMergeInto` delegates to `Workspace.squashMergeInto`.
4. Inside `Workspace.squashMergeInto`:
   - `ensureGitRepo(this.path)`.
   - Gets `sourceBranch` from `this.currentBranch`. Throws if detached.
   - Creates temp dir via `fs.mkdtemp`.
   - Records worktree count before via `git worktree list --porcelain`.
   - **Creates a temporary worktree** for the target branch:
     - If local ref `refs/heads/<targetBranch>` exists: `git worktree add <tempDir> <targetBranch>`.
     - Else if remote ref `refs/remotes/origin/<targetBranch>` exists: `git worktree add -B <targetBranch> <tempDir> origin/<targetBranch>`.
     - Else: throws `WorkspaceError("branch_not_found", ...)`.
   - **In the temp worktree:**
     - `git merge --squash <sourceBranch>` — applies all changes as staged.
     - `git commit --no-verify -m <commitMessage>` — creates the squash commit with the server-provided message.
     - `git rev-parse HEAD` — gets commit SHA.
   - **Cleanup (finally block):**
     - `git worktree remove <tempDir> --force` (allowFailure).
     - `fs.rm(tempDir, { recursive: true, force: true })`.
     - Asserts worktree count matches pre-operation count. Throws if cleanup failed.
5. Returns `{ merged: true, commitSha }`.
   - Note: `targetBranch` is in the internal result but the command result schema only includes `{ merged, commitSha }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `ensureGitRepo`, `hasRef`, `revParse`, `hasUncommittedChanges`, `createTempDir` shared.
- `Workspace.commit` reused for the prep commit.

## Flags

1. ~~**Fetch failure silently swallowed.**~~ **Resolved** — Fetch removed. If the target branch doesn't exist locally or as a remote tracking ref, `squashMergeInto` throws `WorkspaceError("branch_not_found", ...)`.
2. ~~**Hardcoded commit messages.**~~ **Resolved** — `commitMessage` is now a required field on the command schema. The server generates it via AI inference (with fallback).
3. ~~**No conflict handling.**~~ **Resolved** — `WorkspaceError` now carries a `code` field; merge conflicts surface as `"merge_conflict"` or `"git_command_failed"`.
4. **The result schema requires `commitSha` even when `merged` is false** — but the implementation always returns `merged: true` or throws. The `merged: boolean` field is never `false`.
5. **`--no-verify` on squash commit.** The squash commit in the temp worktree uses `--no-verify` since it's an automated system commit. Pre-commit hooks are skipped.

## Usages

| Caller                                                      | Location                                         | Trigger                                                      |
| ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `POST /environments/:id/actions` (action: `"squash_merge"`) | `apps/server/src/routes/environments.ts:132-143` | Client squash-merges workspace branch via environment action |

---

## Updates

- **Error codes now structured.** `WorkspaceError` carries a `code` field. Squash merge failures now surface specific codes: `"detached_head"` (detached workspace), `"branch_not_found"` (target branch missing), `"git_command_failed"` (merge conflicts or other git failures), `"worktree_cleanup_failed"` (cleanup assertion). Resolves flag 3.
- **2026-03-30: Commit message, no-verify, and prep commit changes.** `commitMessage` added to command schema — server generates via AI inference. Fetch and internal prep commit removed from workspace layer; server now handles pre-merge commit and detached-HEAD guard at the route level. Squash commit uses `--no-verify`. Resolves flags 1, 2.

## Review Comments

All review comments below have been resolved:

> We need to fetch the target branch from origin.

**Resolved:** Fetch removed entirely. If the target branch doesn't exist as a local or remote tracking ref, `squashMergeInto` throws `"branch_not_found"`.

> This is very surprising, I thought we had auto commit message generation. please look into this.

**Resolved:** Server now generates commit messages via `generateCommitMessage()` (AI inference with 10s timeout, Zod-parsed response). Falls back to `"bb: squash merge"`.

> I think the commit operations need no verify too

**Resolved:** Squash commit uses `--no-verify`. Regular `workspace.commit` dispatched by the daemon also uses `noVerify: true`.
