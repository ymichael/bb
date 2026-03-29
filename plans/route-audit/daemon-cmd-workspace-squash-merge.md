# `workspace.squash_merge` — Squash-merge current branch into target (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:218-221`
**Handler:** `apps/host-daemon/src/command-handlers/workspace.ts:5-17`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:323-326`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry. |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `targetBranch` | Yes | The branch to squash-merge into (e.g., `main`). |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` delegates to `squashMerge(command, runtimeManager)`.
2. `squashMerge` (workspace.ts:5-17): calls `requireWorkspaceEnvironment`, then `entry.workspace.squashMergeInto({ targetBranch })`.
3. `WorkspaceImpl.squashMergeInto` delegates to `Workspace.squashMergeInto`.
4. Inside `Workspace.squashMergeInto` (workspace.ts:342-413):
   - `ensureGitRepo(this.path)`.
   - Gets `sourceBranch` from `this.currentBranch`. Throws if detached.
   - **If uncommitted changes exist:** auto-commits with message `"bb squash merge prep"` via `this.commit(...)`.
   - **Fetches target branch from origin** (best-effort, `.catch(() => undefined)`): `git fetch origin <targetBranch>`.
   - Creates temp dir via `fs.mkdtemp`.
   - Records worktree count before via `git worktree list --porcelain`.
   - **Creates a temporary worktree** for the target branch:
     - If local ref `refs/heads/<targetBranch>` exists: `git worktree add <tempDir> <targetBranch>`.
     - Else if remote ref `refs/remotes/origin/<targetBranch>` exists: `git worktree add -B <targetBranch> <tempDir> origin/<targetBranch>`.
     - Else: throws `WorkspaceError`.
   - **In the temp worktree:**
     - `git merge --squash <sourceBranch>` — applies all changes as staged.
     - `git commit -m "bb squash merge"` — creates the squash commit.
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

1. **Fetch failure silently swallowed.** The `.catch(() => undefined)` on fetch means if origin is unreachable, the merge proceeds against a potentially stale local target branch. This is intentional (offline-friendly) but worth noting.
2. **Hardcoded commit messages.** The squash merge commit message is always `"bb squash merge"`. The caller cannot customize it. The server may want to provide a message.
3. **No conflict handling.** If `git merge --squash` produces conflicts, `runGit` will throw a raw `WorkspaceError`. There is no structured error code for merge conflicts.
4. **The result schema requires `commitSha` even when `merged` is false** — but the implementation always returns `merged: true` or throws. The `merged: boolean` field is never `false`.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `POST /environments/:id/actions` (action: `"squash_merge"`) | `apps/server/src/routes/environments.ts:132-143` | Client squash-merges workspace branch via environment action |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->