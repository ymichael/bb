# `workspace.demote` — Restore primary checkout to default branch (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:241-248`
**Handler:** `apps/host-daemon/src/command-handlers/workspace.ts:29-37`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:336-338`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the environment workspace (source). |
| `environmentStatus` | Yes | Must be `"ready"`. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `threadId` | Yes | Included in schema but **not used** by the handler or any downstream code. |
| `primaryPath` | Yes | Absolute path to the primary checkout. Opened as a separate workspace. |
| `defaultBranch` | Yes | Branch to switch the primary checkout back to (e.g., `main`). |
| `envBranch` | Yes | Branch to reattach the source/environment workspace to. |

**6 of 7 fields consumed. `threadId` is dead.**

## Implementation Trace

1. `dispatchCommand` delegates to `demoteWorkspace(command, runtimeManager)`.
2. `demoteWorkspace` handler (workspace.ts:29-37):
   - `requireWorkspaceEnvironment(command, runtimeManager)` — gets environment entry (source).
   - `runtimeManager.openWorkspace(command.primaryPath)` — provisions unmanaged workspace at primary path.
   - Calls `entry.workspace.demote({ primary: primaryWorkspace, defaultBranch, envBranch })`.
3. `WorkspaceImpl.demote` (provision.ts:205-218):
   - If `envBranch` is provided, uses it. Otherwise falls back to `this.ws.currentBranch` (but command always provides it).
   - Delegates to `demoteWorkspace({ source, primary, defaultBranch, envBranch })` in `promote.ts`.
4. `demoteWorkspace` in `promote.ts:49-61`:
   - **Asserts primary is clean:** `assertWorkspaceClean(primary, "demote primary")`. Throws if dirty.
   - **Does NOT check source cleanliness** (source may be in detached HEAD state from promote).
   - **Switches primary to default branch:** `primary.checkoutBranch(defaultBranch)`.
     - Uses `Workspace.checkoutBranch` — same logic as promote (local, remote, or create).
   - **Reattaches source to env branch:** `source.checkoutBranch(envBranch)`.
     - This reverses the `detachHead()` from promote.
5. Returns `{ ok: true }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `runtimeManager.openWorkspace` shared.
- `assertWorkspaceClean` shared with promote.
- `Workspace.checkoutBranch` reused.

## Flags

1. **`threadId` is accepted but never consumed.** Dead parameter. Same issue as promote.
2. **No rollback on partial failure.** If `primary.checkoutBranch(defaultBranch)` succeeds but `source.checkoutBranch(envBranch)` fails, the primary is on default branch but the source remains detached. The environment is in a broken state.
3. **Source cleanliness not checked.** The promote path detaches source HEAD, so source should be clean after promote. But if something created changes in the detached state, demote would proceed anyway. This is probably fine since demote only checks out a branch (no merge), but worth noting.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `POST /environments/:id/actions` (action: `"demote"`) | `apps/server/src/routes/environments.ts:193-206` | Client demotes environment workspace back to default branch via environment action |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->