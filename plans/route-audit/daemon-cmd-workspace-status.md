# `workspace.status` — Get workspace git status (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:202-205`
**Handler:** `apps/host-daemon/src/command-dispatch.ts:115-120` (inline in dispatch)
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:315-317`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Inherited from `hostDaemonWorkspaceTargetSchema`. Used to look up or lazily create the runtime entry. |
| `environmentStatus` | Yes | Must be literal `"ready"`. Guard checked by `requireWorkspaceEnvironment`. |
| `workspacePath` | Yes | Inherited from workspace target. Used to lazily provision workspace if entry missing. |
| `mergeBaseBranch` | Yes | Branch name passed to `workspace.getStatus()` to compute ahead/behind counts and merge-base ref. |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` matches `"workspace.status"`, calls `requireWorkspaceEnvironment(command, runtimeManager)`.
   - Validates `environmentStatus === "ready"`.
   - Looks up existing entry or lazily provisions via `ensureEnvironment`.
2. Calls `entry.workspace.getStatus({ mergeBaseBranch: command.mergeBaseBranch })`.
   - **BUG:** `WorkspaceImpl.getStatus()` (provision.ts:165-167) does NOT forward the `options` argument to `this.ws.getStatus()`. The signature accepts `StatusOptions` but the body calls `this.ws.getStatus()` with no args. The `mergeBaseBranch` from the command is silently dropped, and `Workspace.getStatus` falls back to `readDefaultBranch()`.
3. Inside `Workspace.getStatus` (workspace.ts:109-186):
   - `ensureGitRepo(this.path)` — validates path is a git repo.
   - Resolves `mergeBaseBranch` — uses the passed option or falls back to `readDefaultBranch`.
   - Runs in parallel:
     - `git status --porcelain=v1 --branch --untracked-files=all`
     - `git diff --numstat HEAD --`
     - `getCurrentBranch` (`git symbolic-ref --quiet --short HEAD`)
     - `readDefaultBranch` (checks `refs/remotes/origin/HEAD`, then local `main`/`master`)
     - `listBranches` (`git for-each-ref --format=%(refname:short) refs/heads`)
   - Computes `mergeBaseRef` via `git merge-base <mergeBaseBranch> HEAD`.
   - Computes ahead/behind via `git rev-list --left-right --count <mergeBaseBranch>...HEAD`.
   - Derives `state` enum from dirty/committed/untracked signals.
4. Returns `{ workspaceStatus }` (nullable per result schema, but implementation always returns a value or throws).

## Code Reuse

- `requireWorkspaceEnvironment` shared across all workspace commands.
- `ensureGitRepo`, `readDefaultBranch`, `readMergeBaseRef`, `listBranches`, `getCurrentBranch` shared git helpers.

## Flags

1. **`WorkspaceImpl.getStatus` drops options.** `provision.ts:165` defines `getStatus(): Promise<WorkspaceStatus>` with no params, ignoring the `StatusOptions` argument. The `mergeBaseBranch` passed from the command is never forwarded to `Workspace.getStatus`. This means the command always computes status against the default branch, not the caller-specified merge base.
2. Result schema declares `workspaceStatus` as `nullable()`, but the implementation never returns `null` — it either returns the status object or throws. The nullable type is misleading.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `GET /environments/:id/status` | `apps/server/src/routes/environments.ts:42-53` | Client requests environment workspace status |
| `POST /threads/:id/archive` (pre-check) | `apps/server/src/routes/threads/actions.ts:214-225` | Archive handler checks for uncommitted/unmerged changes before archiving (non-force mode) |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->