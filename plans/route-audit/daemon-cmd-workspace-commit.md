# `workspace.commit` — Commit all changes (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:213-216`
**Handler:** `apps/host-daemon/src/command-dispatch.ts:131-135` (inline in dispatch)
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:319-322`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry. |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `message` | Yes | Commit message string, min 1 char. Passed directly as the `-m` argument to `git commit`. |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` matches `"workspace.commit"`, calls `requireWorkspaceEnvironment`.
2. Calls `entry.workspace.commit({ message })`.
   - `WorkspaceImpl.commit` delegates to `Workspace.commit`.
3. Inside `Workspace.commit` (workspace.ts:220-231):
   - `ensureGitRepo(this.path)`.
   - `git add -A` — stages everything (tracked, modified, untracked, deleted).
   - `git commit -m <message>` — creates the commit.
   - `git rev-parse HEAD` — reads the new commit SHA.
   - `git log -1 --pretty=%s` — reads the commit subject.
4. Returns `{ commitSha, commitSubject }`.

## Code Reuse

- `requireWorkspaceEnvironment`, `ensureGitRepo`, `revParse`, `runGit` shared.
- `Workspace.commit` is also reused internally by `checkpoint` and `squashMergeInto` (prep commit).

## Flags

1. **No-op guard missing.** If there are no changes to commit, `git commit` will fail with a non-zero exit code, which `runGit` will throw as a `WorkspaceError`. This is arguably correct behavior (caller shouldn't commit when clean), but the error message will be a raw git error rather than a structured domain error.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `POST /environments/:id/actions` (action: `"commit"`) | `apps/server/src/routes/environments.ts:103-114` | Client commits workspace changes via environment action |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->