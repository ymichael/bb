# `workspace.list_files` — List files in workspace (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:250-253`
**Handler:** `apps/host-daemon/src/command-handlers/workspace-files.ts:15-45`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:339-341`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field | Required | Notes |
|---|---|---|
| `environmentId` | Yes | Identifies the runtime entry. |
| `environmentStatus` | Yes | Must be `"ready"`. |
| `workspacePath` | Yes | Fallback for lazy provisioning. |
| `query` | No | Optional substring filter (case-insensitive). Filters the file list by matching against the full relative path. |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` delegates to `listWorkspaceFiles(command, runtimeManager)`.
2. `listWorkspaceFiles` (workspace-files.ts:15-45):
   - `requireWorkspaceEnvironment(command, runtimeManager)`.
   - Gets `workspacePath` from `entry.workspace.path`.
   - **Primary path: git ls-files.**
     - `git ls-files --cached --others --exclude-standard` — lists tracked files plus untracked (excluding gitignored).
     - `maxBuffer: 10 * 1024 * 1024` (10 MB).
     - Splits stdout by newline, filters empty lines.
   - **Fallback: recursive directory walk** (if git command fails, e.g., not a git repo).
     - `listFilesRecursively` — walks the directory tree.
     - Skips entries starting with `.` and `node_modules`.
     - Returns relative paths.
   - **Filter by query** (if `command.query` provided):
     - `filePaths.filter(p => p.toLowerCase().includes(lowerQuery))`.
   - Maps to `{ path, name: path.basename(path) }`.
3. Returns `{ files: Array<{ path, name }> }`.

## Code Reuse

- `requireWorkspaceEnvironment` shared.
- Uses `node:child_process.execFile` directly (not `runGit` from the workspace package). This is a separate implementation in the daemon's command handler.

## Flags

1. **Does not use the shared `runGit` helper.** Uses its own `execFileAsync("git", ...)` instead of the workspace package's `runGit`. This means different error handling, different buffer sizes (10MB vs 16MB), and different timeout behavior.
2. **No pagination or limit.** Large repos could return enormous file lists. The 10MB buffer mitigates OOM from git output, but the resulting JSON payload could still be very large.
3. **Fallback swallows all errors.** The `catch` block on the git command catches everything (not just "not a git repo") and falls back to the recursive walker. A permissions error or timeout would silently degrade rather than report failure.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `GET /threads/:id/workspace/files` | `apps/server/src/routes/threads/data.ts:94-106` | Client lists files in a thread's workspace |
| `GET /projects/:id/files` | `apps/server/src/routes/projects.ts:170-181` | Client lists files in a project's primary source workspace |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->