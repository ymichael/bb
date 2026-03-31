# `environment.provision` -- Provision a Workspace (Host-Daemon Command)

**Schema:** `packages/host-daemon-contract/src/commands.ts:187` (discriminated union on `workspaceProvisionType`)
**Handler:** `apps/host-daemon/src/command-handlers/environment.ts:6`
**Result Schema:** `packages/host-daemon-contract/src/commands.ts:309`
**Workspace Lane:** Yes (serialized per `environmentId` via `CommandRouter.runInEnvironmentLane`)

## Command Payload

### Base fields (all variants)

| Field | Required | Notes |
|---|---|---|
| `type` | Yes | Literal `"environment.provision"`. |
| `environmentId` | Yes | Target environment. Used as key for runtime manager entry and lane serialization. |
| `workspaceProvisionType` | Yes | Discriminant: `"unmanaged"`, `"managed-worktree"`, or `"managed-clone"`. |

### Variant: `unmanaged`

| Field | Required | Notes |
|---|---|---|
| `path` | Yes | Path to validate. Passed through `toProvisionWorkspaceOptions` to `provisionWorkspace({ workspaceProvisionType: "unmanaged", path })`. |

### Variant: `managed-worktree`

| Field | Required | Notes |
|---|---|---|
| `sourcePath` | Yes | Source repo path (primary checkout). Used as worktree source and setup script detection root. |
| `targetPath` | Yes | Where to create the worktree. Becomes the workspace path. |
| `branchName` | Yes | Branch name for the new worktree. Passed to `git worktree add -B`. |
| `setupScript` | Yes | Setup script filename to run after provisioning (server passes `.bb-env-setup.sh`). |
| `setupTimeoutMs` | Yes | Maximum time in ms to wait for the setup script (server passes 15 min). |

### Variant: `managed-clone`

| Field | Required | Notes |
|---|---|---|
| `sourcePath` | Yes | Source repo path to clone from. Also used for setup script detection. |
| `targetPath` | Yes | Where to create the clone. Becomes the workspace path. |
| `branchName` | Yes | Branch name created after cloning via `git checkout -B`. |
| `setupScript` | Yes | Setup script filename to run after provisioning (server passes `.bb-env-setup.sh`). |
| `setupTimeoutMs` | Yes | Maximum time in ms to wait for the setup script (server passes 15 min). |

**`projectId` removed. `setupScript` and `setupTimeoutMs` added as required fields on managed variants.**

## Implementation Trace

### Entry point: `provisionEnvironment` (environment.ts:6)

1. Checks `options.runtimeManager.get(command.environmentId)` to determine if the environment already exists (`alreadyExists`).
2. Calls `options.runtimeManager.ensureEnvironment({ environmentId, provision: toProvisionWorkspaceOptions(command) })`.
   - `ensureEnvironment` is idempotent: if an entry already exists or is pending, returns it immediately.
   - Otherwise creates a new entry via `createEntry`.
3. If `!alreadyExists && entry.workspace.managed`, calls `detectSetupScript(command)`.
   - `detectSetupScript` reads the script name from `command.setupScript` for managed variants.
   - For unmanaged: returns `false` (no setup script support).
   - For managed-worktree/managed-clone: checks if `command.setupScript` exists in `command.sourcePath`.
   - Returns `true` if the file exists, `false` otherwise.
4. If `entry.workspace.isGitRepo`, calls `entry.workspace.getStatus()` and reads `defaultBranch`.
5. Calls `entry.workspace.currentBranch()` for the branch name.
6. Returns `{ path, isGitRepo, isWorktree, branchName, defaultBranch, ranSetup }`.

### Path A: `unmanaged`

`toProvisionWorkspaceOptions` returns `{ workspaceProvisionType: "unmanaged", path }`.

1. `RuntimeManager.createEntry` calls `provisionWorkspace({ workspaceProvisionType: "unmanaged", path })`.
2. `provisionUnmanaged` (workspace/provision.ts:242):
   - Checks `pathExists(path)` -- throws `WorkspaceError` if not found.
   - Calls `detectGitRepo(path)` and `detectWorktree(path)`.
   - Returns `WorkspaceImpl` with `managed: false`, no destroy behavior.
3. Back in `provisionEnvironment`:
   - `alreadyExists` is false on first call, but `entry.workspace.managed` is `false`, so `detectSetupScript` returns `false`.
   - `ranSetup` is `false`.

### Path B: `managed-worktree`

`toProvisionWorkspaceOptions` returns `{ workspaceProvisionType: "managed-worktree", sourcePath, targetPath, branchName }`.

1. `RuntimeManager.createEntry` calls `provisionWorkspace(...)`.
2. `provisionWorktree` (workspace/provision.ts:265):
   - **Idempotency check:** `ensureExistingWorkspaceMatches(targetPath, branchName)`.
     - If target exists, is a git repo, and is on the correct branch, returns early with `{ path: targetPath }`.
     - If target exists but is wrong branch or not a git repo, throws.
   - `createWorktree` (provisioning.ts:90):
     - Runs `git worktree add -B <branchName> <targetPath>` from `sourcePath`.
     - Calls `runSetupScript({ workspacePath: targetPath, scriptName, timeoutMs })`.
       - Looks for the setup script (from `command.setupScript`) in targetPath (the new worktree).
       - Runs it via `/bin/bash` with server-controlled timeout (from `command.setupTimeoutMs`), captures stdout/stderr.
       - Throws on non-zero exit, timeout, or signal.
     - On failure: calls `removeWorktree({ path: targetPath, force: true })` for rollback.
   - Returns `WorkspaceImpl` with `managed: true`, `isWorktree: true`.
     - Destroy: `removeWorktree({ path, force: true })` -- resolves common dir and runs `git worktree remove`, then `fs.rm`.
3. Back in `provisionEnvironment`:
   - `detectSetupScript(command)` checks for `command.setupScript` in `command.sourcePath`.
   - `ranSetup` reports whether the script **exists** in source, not whether it actually ran.

### Path C: `managed-clone`

`toProvisionWorkspaceOptions` returns `{ workspaceProvisionType: "managed-clone", sourcePath, targetPath, branchName }`.

1. `RuntimeManager.createEntry` calls `provisionWorkspace(...)`.
2. `provisionClone` (workspace/provision.ts:286):
   - **Idempotency check:** same `ensureExistingWorkspaceMatches` as worktree.
   - `createClone` (provisioning.ts:116):
     - Runs `git clone <sourcePath> <targetPath>` from `dirname(targetPath)`.
     - Runs `git checkout -B <branchName>` in `targetPath`.
     - Calls `runSetupScript({ workspacePath: targetPath, ... })`.
     - On failure: calls `removeDirectory({ path: targetPath })` for rollback.
   - Returns `WorkspaceImpl` with `managed: true`, `isWorktree: false`.
     - Destroy: `removeDirectory({ path })` -- `fs.rm` recursive.
3. Back in `provisionEnvironment`:
   - Same as Path B: `detectSetupScript` checks `command.sourcePath` for `command.setupScript`.

## Code Reuse

- `toProvisionWorkspaceOptions` maps the command discriminant to `ProvisionWorkspaceOpts` for the workspace package.
- `detectSetupScript` is shared across all three variants (switches on `workspaceProvisionType`).
- `ensureExistingWorkspaceMatches` is shared between worktree and clone paths for idempotency.
- `runSetupScript` is shared between worktree and clone creation.
- `RuntimeManager.ensureEnvironment` handles dedup of concurrent provision requests via `pendingEntries`.

## Flags

1. ~~**`projectId` is a dead param.**~~ **Resolved.** Removed from `environmentProvisionCommandBaseSchema` and all callers.
2. **`ranSetup` reports script existence, not execution.** `detectSetupScript` checks if `command.setupScript` exists in the source path. Meanwhile the actual setup script execution happens inside `createWorktree`/`createClone` via `runSetupScript`, which checks the *target* path. These are different paths -- the script might exist in source but not be copied to target (e.g., if it is gitignored). The name `ranSetup` implies the script ran, but the check is only whether it exists at the source. On idempotent re-provision (target already exists), `runSetupScript` is skipped but `detectSetupScript` would still return true.
3. ~~**`toProvisionWorkspaceOptions` has redundant validation.**~~ **Resolved.** Removed the dead guard; schema validation is sufficient.
4. ~~**Setup script timeout and scriptName are not configurable from the command.**~~ **Resolved.** `setupScript` (`z.string().min(1)`) and `setupTimeoutMs` (`z.number().int().positive()`) are now required fields on both managed variants. The server passes `".bb-env-setup.sh"` and `15 * 60 * 1000` (15 min). The daemon passes them through to `provisionWorkspace` as `scriptName` and `timeoutMs`. Default timeout in `packages/workspace/src/provisioning.ts` also updated from 5 min to 15 min, and shell changed from `/bin/sh` to `/bin/bash`.

## Usages

| Caller | Location | Trigger |
|---|---|---|
| `createThreadFromRequest` (unmanaged) | `apps/server/src/services/thread-create.ts:332` | Thread creation with unmanaged workspace. Calls `queueEnvironmentProvision` with `workspaceProvisionType: "unmanaged"`. Fire-and-forget via `queueCommand`. |
| `createThreadFromRequest` (managed) | `apps/server/src/services/thread-create.ts:343` | Thread creation with managed-worktree or managed-clone workspace. Calls `queueEnvironmentProvision` with the managed type. Fire-and-forget via `queueCommand`. |
| `ensureProjectSourceEnvironment` | `apps/server/src/services/thread-create.ts:390` | Called by `GET /projects/:id/files` to ensure the project source environment is provisioned. Calls `queueCommandAndWait` directly (synchronous wait, 30s timeout). |
| `queueManagedEnvironmentReprovision` | `apps/server/src/services/environment-provisioning.ts:120` | Called by `dispatchThreadTurn` when a managed environment needs reprovisioning before a new turn. Calls `queueEnvironmentProvision`. Fire-and-forget via `queueCommand`. |

---

## Updates

- **Error codes now structured.** `WorkspaceError` carries a `code` field. Provision failures now surface specific codes: `"path_not_found"` (unmanaged path missing), `"path_exists"` (target already exists with wrong state), `"setup_script_failed"` (env setup script non-zero exit), `"git_command_failed"` (worktree/clone git failures).
- **Managed workspace re-provision fix.** Other workspace commands (commit, diff, etc.) now send `workspaceContext: { workspacePath, workspaceProvisionType }` instead of flat `workspacePath`. The daemon's `requireWorkspaceEnvironment` uses `workspaceProvisionType` when lazily re-provisioning after a daemon restart. Previously, lazy re-provisioning always hardcoded `"unmanaged"`, which meant managed worktree/clone environments would be incorrectly re-provisioned as unmanaged. This bug is now fixed.
- **`reconnectManaged` helper extracted.** Managed workspace reconnection (after daemon restart) now uses a shared `reconnectManaged(wsPath, destroyFn)` helper in `packages/workspace/src/provision.ts`. The helper validates the workspace still exists on disk, wraps it as a `WorkspaceImpl`, and provides the correct destroy function. `reconnectManagedWorktree` and `reconnectManagedClone` are thin wrappers that pass the appropriate destroy function (`removeWorktree` vs `removeDirectory`). The `RuntimeManager` maps `managed-worktree` to `reconnect-managed-worktree` and `managed-clone` to `reconnect-managed-clone` provision types when re-provisioning.

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
