# Route Audit

Current inline docs from the contract packages. Review for accuracy.

Delete this file after review — the source of truth is the inline JSDoc in the contract files.

---

## Public API (`@bb/server-contract`)

### Projects

| Route | Inline doc |
|---|---|
| `GET /projects` | |
| `POST /projects` | |
| `GET /projects/:id` | |
| `PATCH /projects/:id` | |
| `DELETE /projects/:id` | Also cleans up attachment files for the project. |
| `POST /projects/:id/sources` | |
| `PATCH /projects/:id/sources/:sourceId` | |
| `DELETE /projects/:id/sources/:sourceId` | |
| `GET /projects/:id/files` | Search files in the project. Used for file mentions in the prompt box. Proxies to `workspace.list_files` on the project's default source host. |
| `POST /projects/:id/attachments` | Upload a file attachment. Used to attach files to user messages. |
| `GET /projects/:id/attachments/content` | Serve an uploaded attachment's content. Used to render attachment previews. |
| `POST /projects/:id/managers` | Same flow as POST /threads with type="manager". |

### Hosts

| Route | Inline doc |
|---|---|
| `GET /hosts` | Host `status` is derived at query time from the `host_daemon_sessions` table. |
| `GET /hosts/:id` | |

### Environments

| Route | Inline doc |
|---|---|
| `GET /environments/:id` | |
| `GET /environments/:id/status` | Proxies to `workspace.status`. |
| `GET /environments/:id/diff` | Proxies to `workspace.diff`. |
| `GET /environments/:id/diff/branches` | Proxies to `workspace.list_branches`. |
| `POST /environments/:id/actions` | Execute an environment action (commit, squash_merge, promote, demote). Returns 409 if blocked. |

### Threads

| Route | Inline doc |
|---|---|
| `GET /threads` | Supports filters: projectId, type, parentThreadId, archived. |
| `POST /threads` | Environment type determines the flow: "reuse" attaches to existing, "host" provisions new, "sandbox-host" returns 501. If input is provided, starts automatically after provisioning. Title generated asynchronously if not provided. |
| `GET /threads/:id` | |
| `PATCH /threads/:id` | If the title changes, also notifies the provider via `thread.rename`. |
| `DELETE /threads/:id` | Also destroys its environment if one exists. |
| `POST /threads/:id/send` | Idle thread → starts a new turn. Active thread with mode=steer → steers the current turn. |
| `POST /threads/:id/drafts` | |
| `POST /threads/:id/drafts/:draftId/send` | Starts or steers a turn, then deletes the draft. |
| `DELETE /threads/:id/drafts/:draftId` | |
| `POST /threads/:id/stop` | |
| `POST /threads/:id/archive` | Rejects if work could be lost (unless force=true). Stops if active. If managed environment has zero non-archived threads, destroys it. |
| `POST /threads/:id/unarchive` | |
| `POST /threads/:id/read` | |
| `POST /threads/:id/unread` | |
| `GET /threads/:id/timeline` | Events transformed via `@bb/core-ui`. |
| `GET /threads/:id/timeline/tool-details` | Used by the UI to lazy-load expanded tool information. |
| `GET /threads/:id/output` | |
| `GET /threads/:id/events` | Supports `afterSeq` and `limit` pagination. |
| `GET /threads/:id/default-execution-options` | Returns the last used options for the thread for use as defaults in the UI. |
| `GET /threads/:id/workspace/files` | Resolves thread → environment → host, proxies to `workspace.list_files`. |
| `GET /threads/:id/workspace/file` | Proxies to `workspace.read_file`. |

### System

| Route | Inline doc |
|---|---|
| `GET /system/config` | |
| `GET /system/models` | Proxies to `provider.list_models`. Can target a specific host or environment. |
| `GET /system/providers` | Proxies to `provider.list`. Can target a specific host or environment. |
| `POST /system/voice-transcription` | Accepts audio file and optional prompt context. |

---

## Internal API (`@bb/host-daemon-contract` session routes)

| Route | Inline doc |
|---|---|
| `POST /internal/session/open` | Used by the daemon to establish a session with the server. Replaces any prior session for the same host. |
| `GET /internal/session/commands` | Used by the daemon to fetch pending commands. Supports long-poll via `waitMs`. |
| `POST /internal/session/command-result` | Used by the daemon to report that a command has completed (success or error). |
| `POST /internal/session/events` | Used by the daemon to stream provider events back to the server. |
| `POST /internal/session/tool-call` | Used by the daemon to execute server-side tool calls on behalf of a provider (e.g. spawn_thread). |

---

## Daemon Commands (`@bb/host-daemon-contract`)

### Thread commands (not lane-serialized)

| Command | Inline doc |
|---|---|
| `thread.start` | |
| `thread.resume` | Reconnect after daemon restart. Does not start a turn. |
| `turn.run` | Run a conversation turn. Used for every message after the first. |
| `turn.steer` | |
| `thread.stop` | |
| `thread.rename` | |

### Provider commands (not lane-serialized)

| Command | Inline doc |
|---|---|
| `provider.list` | |
| `provider.list_models` | |

### Environment commands (lane-serialized per environmentId)

| Command | Inline doc |
|---|---|
| `environment.provision` | Discriminated by `workspaceProvisionType`: unmanaged, managed-worktree, managed-clone. Idempotent. |
| `environment.destroy` | |

### Workspace commands (lane-serialized per environmentId)

| Command | Inline doc |
|---|---|
| `workspace.status` | |
| `workspace.diff` | |
| `workspace.commit` | |
| `workspace.squash_merge` | |
| `workspace.reset` | Internal use only — not exposed via public API. |
| `workspace.checkpoint` | Internal use only — not exposed via public API. |
| `workspace.promote` | Switch the project's primary checkout to the environment's branch. |
| `workspace.demote` | Reverse a prior promote — restore primary to default branch. |
| `workspace.list_files` | |
| `workspace.read_file` | |
| `workspace.list_branches` | |
