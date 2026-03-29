# `workspace.diff` — Get workspace git diff (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:207-210`
**Handler:** `apps/host-daemon/src/command-dispatch.ts:122-129` (inline in dispatch)
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:318-320`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Inherited from workspace target. Identifies the runtime entry. |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload. |
| `workspacePath` | Yes | Fallback path for lazy workspace provisioning. |
| `selection` | Yes | `ThreadGitDiffSelection` — discriminated union: `{ type: "combined" }` or `{ type: "commit", sha: string }`. Determines which diff is returned. |
| `mergeBaseBranch` | Yes | Branch name used as merge-base reference for the diff range. |

**All 5 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` matches `"workspace.diff"`, calls `requireWorkspaceEnvironment`.
2. Calls `entry.workspace.getDiff({ mergeBaseBranch, selection })`.
   - `WorkspaceImpl.getDiff` (provision.ts:169-171) correctly forwards `options` to `this.ws.getDiff(options)`.
3. Inside `Workspace.getDiff` (workspace.ts:188-214):
   - `ensureGitRepo(this.path)`.
   - Gets `currentBranch`.
   - Resolves `mergeBaseBranch` (passed or default).
   - Computes `mergeBaseRef` via `git merge-base <mergeBaseBranch> HEAD`.
   - Delegates to `buildDiffSummary({ mergeBaseRef, selection })`.
4. `buildDiffSummary` (workspace.ts:415-464):
   - Checks `hasUncommittedChanges` via `git status --porcelain=v1 --untracked-files=all`.
   - Reads commit summaries via `git log --reverse --format=... <mergeBaseRef>..HEAD`.
   - Determines `mode`: `"local_uncommitted"` if dirty, else `"worktree_commits"`.
   - Diff selection:
     - `{ type: "commit" }`: `git show --format= --no-ext-diff <sha>`
     - `"local_uncommitted"` mode: `git diff --no-ext-diff --binary HEAD --`
     - Else (committed, combined): `git diff --no-ext-diff --binary <mergeBaseRef>..HEAD`
   - Truncates diff if `maxBytes` exceeded (not set by this command path).
5. Returns `{ diff: ThreadGitDiffResponse }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `ensureGitRepo`, `readMergeBaseRef`, `hasUncommittedChanges` shared.
- `buildDiffSummary` and `readCommitSummaries` are private to `Workspace`.

## Flags

None. Clean.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `GET /environments/:id/diff` | `apps/server/src/routes/environments.ts:59-72` | Client requests environment workspace diff |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
