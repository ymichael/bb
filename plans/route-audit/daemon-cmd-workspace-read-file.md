# `workspace.read_file` — Read a file from the workspace (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:255-258`
**Handler:** `apps/host-daemon/src/command-handlers/workspace-files.ts:66-86`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:342-345`
**Workspace Lane:** Yes (serialized per environment via `requireWorkspaceEnvironment`)

## Command Payload

| Field               | Required | Notes                                                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `environmentId`     | Yes      | Identifies the runtime entry.                                                                          |
| ~~`environmentStatus`~~ | ~~Yes~~ | Removed — no longer part of the command payload.                                                       |
| `workspacePath`     | Yes      | Fallback for lazy provisioning.                                                                        |
| `path`              | Yes      | Relative file path within the workspace. Resolved against workspace root. Path traversal is validated. |

**All 4 fields consumed. No dead params.**

## Implementation Trace

1. `dispatchCommand` delegates to `readWorkspaceFile(command, runtimeManager)`.
2. `readWorkspaceFile` (workspace-files.ts:66-86):
   - `requireWorkspaceEnvironment(command, runtimeManager)`.
   - Gets `workspacePath` from `entry.workspace.path`.
   - **Path traversal check:**
     - `path.resolve(workspacePath, command.path)` — resolves the path.
     - Validates `resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath`.
     - If the resolved path escapes the workspace root, throws `CommandDispatchError("invalid_path", ...)`.
   - **Reads file:** `fs.readFile(resolved, "utf-8")`.
3. Returns `{ path: command.path, content }`.

## Code Reuse

- `requireWorkspaceEnvironment` shared.
- `CommandDispatchError` used for structured error reporting.

## Flags

> **Updated 2026-03-29:** `environmentStatus` removed from all workspace commands. Directory guard and 10MB size limit added. `mimeType` returned in result.

1. ~~**Path traversal check has an edge case.** The check `resolved !== workspacePath` allows reading the workspace root directory itself as a file, which would fail with an EISDIR error from `fs.readFile`. Not a security issue, just an unhelpful error.~~ **Fixed** — directory guard now returns a helpful error.
2. ~~**No size limit on file reads.** Reading a large binary file will load it entirely into memory as a UTF-8 string. Could cause OOM on very large files.~~ **Fixed** — 10MB hardcoded limit added.
3. ~~**Binary files read as UTF-8.** No detection of binary files — they'll be read as garbled UTF-8 strings. The caller gets no signal that the content is binary.~~ **Fixed** — `mimeType` is now returned in the result, allowing callers to detect binary content.

## Usages

| Caller                            | Location                                                   | Trigger                                                                                         |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /threads/:id/workspace/file` | `apps/server/src/routes/threads/data.ts:113-125`           | Client reads a single file from a thread's workspace                                            |
| `readManagerPreferences`          | `apps/server/src/services/thread-runtime-config.ts:95-106` | Server reads `.bb/manager.md` from workspace to build runtime instructions for thread execution |

---

## Review Comments

1. lets handle the "attempting to read a directory case" and return a helpful error

> Done — directory guard added. Attempting to read a directory now returns a `CommandDispatchError` with a helpful message.

2. lets add a reasonable hardcoded max file size limit for now. 10MB seems reasonable?

> Done — 10MB hardcoded limit added. Files exceeding the limit return an error.

3. how would we fix 3? would we also send back a content type?

> Done — `mimeType` field added to the result schema, allowing callers to detect binary content and handle it appropriately.

4. what's the point of the environmentStatus payload attribute?

> Removed — `environmentStatus` has been stripped from all workspace command payloads.
