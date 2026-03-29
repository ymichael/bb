# `workspace.promote` — Switch primary checkout to environment's branch (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:234-239`
**Handler:** `apps/host-daemon/src/command-handlers/workspace.ts:19-27`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:333-335`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry (the environment workspace = source). |
| `environmentStatus` | Yes | Must be `"ready"`. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `threadId` | Yes | Included in schema but **not used** by the handler or any downstream code. |
| `primaryPath` | Yes | Absolute path to the primary (user-facing) checkout. Opened as a separate workspace via `runtimeManager.openWorkspace()`. |

**4 of 5 fields consumed. `threadId` is dead.**

## Implementation Trace

1. `dispatchCommand` delegates to `promoteWorkspace(command, runtimeManager)`.
2. `promoteWorkspace` handler (workspace.ts:19-27):
   - `requireWorkspaceEnvironment(command, runtimeManager)` — gets the environment entry (source workspace).
   - `runtimeManager.openWorkspace(command.primaryPath)` — provisions an unmanaged workspace at the primary path.
   - Calls `entry.workspace.promote(primaryWorkspace)`.
3. `WorkspaceImpl.promote` (provision.ts:197-203):
   - Creates a raw `Workspace` from `primary.path`.
   - Delegates to `promoteWorkspace(this.ws, primaryWs, options)` in `promote.ts`.
4. `promoteWorkspace` in `promote.ts:23-43`:
   - **Asserts source is clean:** `assertWorkspaceClean(source, "promote source")` — checks `hasUncommittedChanges`. Throws if dirty.
   - **Asserts primary is clean:** `assertWorkspaceClean(primary, "promote primary")`. Throws if dirty.
   - Gets `branch` from `source.currentBranch`. Throws if detached HEAD.
   - **Detaches source HEAD:** `source.detachHead()` — runs `git checkout --detach` in the env workspace. This frees the branch name so the primary can check it out (git worktree constraint: two worktrees cannot share a branch).
   - **Checks out branch on primary:** `primary.checkoutBranch(branch)`.
     - If branch exists locally: `git checkout <branch>`.
     - If branch exists on remote: `git checkout -B <branch> origin/<branch>` + `git branch --set-upstream-to origin/<branch> <branch>`.
     - Else: `git checkout -B <branch>` (creates new branch at current HEAD).
5. Returns `{ ok: true }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `runtimeManager.openWorkspace` shared.
- `assertWorkspaceClean`, `promoteWorkspace` in `promote.ts` shared with `demote`.
- `Workspace.detachHead`, `Workspace.checkoutBranch` reused.

## Flags

1. **`threadId` is accepted but never consumed.** Dead parameter. Violates the contract rules ("accepted-but-ignored fields are forbidden").
2. **No rollback on partial failure.** If `source.detachHead()` succeeds but `primary.checkoutBranch()` fails, the source remains in detached HEAD with no recovery. The branch is "orphaned" — neither workspace is on it.
3. The `options?.remote` path in `promote.ts:38-40` is never triggered because `WorkspaceImpl.promote` does not pass `options` from the command (the command schema has no `remote` field). Dead code path.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `POST /environments/:id/actions` (action: `"promote"`) | `apps/server/src/routes/environments.ts:165-176` | Client promotes environment workspace to primary checkout via environment action |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->