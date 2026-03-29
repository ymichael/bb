# `workspace.checkpoint` — Commit and push to remote (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:228-232`
**Handler:** `apps/host-daemon/src/command-dispatch.ts:146-150` (inline in dispatch)
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:328-332`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry. |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `commitMessage` | Yes | Message used for the commit if there are uncommitted changes. Min 1 char. |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` matches `"workspace.checkpoint"`, calls `requireWorkspaceEnvironment`.
2. Calls `entry.workspace.checkpoint({ commitMessage })`.
   - `WorkspaceImpl.checkpoint` delegates to `Workspace.checkpoint`.
3. Inside `Workspace.checkpoint` (workspace.ts:251-278):
   - `ensureGitRepo(this.path)`.
   - Gets `branchName` from `this.currentBranch`. Throws `WorkspaceError("Cannot checkpoint a detached workspace")` if detached.
   - **Conditional commit:**
     - If `hasUncommittedChanges(this.path)` is true: calls `this.commit({ message: commitMessage })`, which runs `git add -A` then `git commit -m <message>`. Captures `commitSha` from the result.
     - If clean: `commitSha = git rev-parse HEAD` (existing HEAD).
   - **Push:** `git push origin <branchName>`.
   - `remoteName` is hardcoded to `"origin"`.
4. Returns `{ commitSha, branchName, remoteName }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `ensureGitRepo`, `hasUncommittedChanges`, `revParse` shared.
- `Workspace.commit` reused for the conditional commit step.

## Flags

1. **Remote name hardcoded to `"origin"`.** Not configurable. Fine for typical setups but worth noting.
2. **No force-push option.** If the remote branch has diverged, `git push` will fail. This is probably the correct safe default, but the error will be a raw git error rather than a structured code.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| _(none)_ | — | No server-side callers. Command is defined and handled but never queued. |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
