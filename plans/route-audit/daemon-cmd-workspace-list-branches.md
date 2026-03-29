# `workspace.list_branches` — List local branches (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:260-262`
**Handler:** `apps/host-daemon/src/command-handlers/workspace-files.ts:88-96`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:346-349`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry. |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |

**All 3 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` delegates to `listBranches(command, runtimeManager)`.
2. `listBranches` handler (workspace-files.ts:88-96):
   - `requireWorkspaceEnvironment(command, runtimeManager)`.
   - Calls `entry.workspace.getBranches()` and `entry.workspace.currentBranch()` in sequence.
3. `WorkspaceImpl.getBranches` delegates to `Workspace.getBranches` which calls `listBranches(this.path)`:
   - `ensureGitRepo(cwd)`.
   - `git for-each-ref --format=%(refname:short) refs/heads` — lists local branch names.
   - Splits by newline, trims, filters empty.
4. `WorkspaceImpl.currentBranch` delegates to `Workspace.currentBranch`:
   - `detectGitRepo(cwd)` — returns `undefined` if not a git repo.
   - `git symbolic-ref --quiet --short HEAD` — returns branch name or `undefined` if detached.
   - Maps `undefined` to `null` in `WorkspaceImpl`.
5. Returns `{ branches: string[], current: string | null }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `ensureGitRepo`, `listBranches` (git.ts), `getCurrentBranch` shared.

## Flags

1. **Sequential instead of parallel.** `getBranches()` and `currentBranch()` are called sequentially but are independent — could be `Promise.all`'d. Minor perf nit.
2. **Only lists local branches.** Remote-tracking branches are not included. This may be intentional but limits visibility for the caller.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `GET /environments/:id/diff/branches` | `apps/server/src/routes/environments.ts:78-89` | Client lists branches for the diff branch selector UI |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
