# Workspace & Host Design

Two cleanly separated concerns: **hosts** (machines) and **workspaces** (directories on those machines).

---

## The Split

| Concern | What it is | Where it runs | Package |
|---|---|---|---|
| **Hosts** | Machines that run environments. User's laptop, E2B sandbox, remote mac-mini. | Server orchestrates (creates/destroys/suspends cloud hosts). Daemon runs on each host. | Server-side code (no shared package) |
| **Workspaces** | Directories on a host. Git operations, provisioning (worktree/clone), setup scripts. | Host-daemon executes. | `@bb/workspace` |

The server never imports `@bb/workspace`. It sends commands to daemons. The daemon imports `@bb/workspace` and uses it when processing commands. E2B/cloud logic lives in the server — it's host orchestration, not workspace operations.

---

## `@bb/workspace` — Package Interface

Used by the host-daemon only.

### Workspace class

A `Workspace` instance represents a specific directory on this machine. Constructed with a path, provides getters for state and methods for git operations.

```typescript
class Workspace {
  readonly path: string;

  constructor(path: string);

  // --- Queries (getters) ---
  get exists(): Promise<boolean>;
  get isGitRepo(): Promise<boolean>;
  get currentBranch(): Promise<string | undefined>;   // undefined if not git or detached HEAD

  getStatus(): Promise<WorkspaceStatus>;
  getDiff(options: DiffOptions): Promise<DiffResult>;
  getBranches(): Promise<string[]>;

  // --- Mutations ---
  commit(options: { message: string; includeUnstaged?: boolean }): Promise<CommitResult>;
  reset(): Promise<void>;                              // discard all uncommitted changes
  fetch(options?: { remote?: string; branch?: string }): Promise<void>;
  checkpoint(options: { commitMessage: string; remoteName?: string }): Promise<CheckpointResult>;

  // --- Branch operations ---
  checkoutBranch(branchName: string): Promise<void>;
  detachHead(): Promise<void>;
  stash(message?: string): Promise<string | null>;     // returns stash ref, null if clean
  stashPop(ref?: string): Promise<void>;

  // --- Squash merge (uses temp worktree internally) ---
  squashMergeInto(options: { targetBranch: string; commitMessage: string }): Promise<SquashMergeResult>;
}
```

### Provisioning functions (standalone, not on Workspace)

These create or destroy workspaces. They don't operate on an existing workspace — they produce one.

```typescript
export function createWorktree(args: {
  sourcePath: string;       // project source path (where .git lives)
  targetPath: string;       // where to create the worktree
  branchName: string;       // branch to create
}): Promise<{ path: string }>;

export function createClone(args: {
  sourcePath: string;       // URL or local path to clone from
  targetPath: string;       // where to clone into
  branchName: string;       // branch to create after clone
}): Promise<{ path: string }>;

export function runSetupScript(args: {
  workspacePath: string;
  scriptName?: string;      // default: ".bb-env-setup.sh"
  timeoutMs?: number;       // default: 5 minutes
}): Promise<{ ran: boolean; exitCode?: number; output?: string }>;

export function removeWorktree(args: {
  path: string;
  force?: boolean;          // default: true
}): Promise<void>;

export function removeDirectory(args: {
  path: string;
}): Promise<void>;
```

### Design principles

- **Workspace is a directory.** The class represents one path. It knows how to query and mutate its own git state. It doesn't know about other workspaces, hosts, servers, or commands.
- **Provisioning is separate.** Creating/destroying workspaces is standalone functions — you can't call methods on a workspace that doesn't exist yet.
- **Branch operations are primitives.** `checkoutBranch`, `detachHead`, `stash`, `stashPop` are building blocks. The daemon composes them for higher-level operations like promote.
- **No host/server awareness.** The package is just git and filesystem operations.

---

## Promote / Demote

Promote switches the user's primary checkout to the environment's branch so they can test the agent's work in their editor. Demote switches back to the default branch.

**Both workspaces must be clean.** Promote and demote fail loudly if either workspace has uncommitted changes. No stashing, no read-tree tricks. The user commits or discards first.

### Same host (v1)

Source and target share the same `.git` (worktree) or are on the same machine (clone). All branches are locally visible.

**Promote:**
```
Server → daemon: workspace.export { environmentId }
Daemon:
  1. Check source workspace is clean → fail if dirty
  2. Record source branch name (e.g., "bb/env-abc")
  3. Detach source HEAD (free the branch for primary to check out)
  4. Return { branch: "bb/env-abc" }

Server → daemon: workspace.import { primaryPath, branch: "bb/env-abc" }
Daemon:
  1. Check primary workspace is clean → fail if dirty
  2. Checkout the branch: git checkout bb/env-abc
  3. Return { ok: true }
```

**Demote:**
```
Server → daemon: workspace.import { primaryPath, branch: "main" }  // project's default branch
Daemon:
  1. Check primary workspace is clean → fail if dirty
  2. Checkout default branch: git checkout main
  3. Return { ok: true }

Server → daemon: workspace.reattach { environmentId, branch: "bb/env-abc" }
Daemon:
  1. Re-attach source worktree to its branch: git checkout bb/env-abc
  2. Return { ok: true }
```

**Idempotent:** Running export twice when already detached is a no-op (already detached). Running import twice with the same branch is a no-op (already on that branch). Running reattach when already attached is a no-op.

**Replay-safe:** No stash state. No mutable intermediate state. If daemon crashes between export and import, the source is detached but the primary hasn't changed — the server can retry or roll back by sending reattach.

**Crash recovery:** If promote partially completes (export done, import not), the server detects the timeout, sends `workspace.reattach` to undo the export. The source gets its branch back. Primary was never modified.

### Different host (E2B → local)

Source and target don't share `.git`. The branch must be pushed to a remote first.

**Promote:**
```
Server → source daemon: workspace.export { environmentId, pushToRemote: "origin" }
Daemon:
  1. Check source is clean → fail if dirty
  2. Push branch to remote: git push origin bb/env-abc
  3. Return { branch: "bb/env-abc", remote: "origin" }

Server → target daemon: workspace.import { primaryPath, branch: "bb/env-abc", remote: "origin" }
Daemon:
  1. Check primary is clean → fail if dirty
  2. Fetch: git fetch origin bb/env-abc
  3. Checkout: git checkout -B bb/env-abc origin/bb/env-abc
  4. Return { ok: true }
```

No detach needed (different repos, no branch conflict). Fail if no remote configured or push fails.

**Demote:** Same as same-host — checkout the default branch. No reattach needed (source was never detached).

### Promoted state is derived

The daemon checks what branch the primary checkout is on. If it matches a known environment branch, that environment is promoted. If the user manually runs `git checkout main`, the environment is no longer promoted. No application state to track.

### Commands

Three commands (replacing old `workspace.promote` / `workspace.demote`):

```
workspace.export    // source daemon: detach (same host) or push (different host), return branch info
workspace.import    // target daemon: checkout the branch in primary
workspace.reattach  // source daemon: re-attach worktree to its branch (undo export, same host only)
```

---

## Command Set

18 commands total:

```
// Thread/provider (via @bb/agent-runtime)
thread.start, thread.resume, turn.run, turn.steer, thread.stop, thread.rename,
provider.list_models

// Environment lifecycle (provisioning via @bb/workspace, E2B via server)
environment.provision, environment.destroy

// Workspace — queries
workspace.status, workspace.diff

// Workspace — mutations
workspace.commit, workspace.squash_merge, workspace.reset, workspace.checkpoint

// Workspace — promote (server-orchestrated between two daemons)
workspace.export, workspace.import, workspace.reattach
```

18 commands total. All carry explicit parameters. Daemon never looks up metadata.

---

## Hosts — Server-Side Orchestration

Host lifecycle is managed by the server. No shared package — this is server application code.

### Host types

| Type | Created by | Lifecycle |
|---|---|---|
| **Persistent** (user's machine) | User starts daemon, auto-registers | Long-lived. Survives reboots. |
| **Ephemeral** (E2B sandbox) | Server calls E2B API | Created on demand. Suspended on idle. Destroyed on cleanup. |

### E2B host lifecycle

```
Server creates sandbox (E2B API)
  → Starts host-daemon inside sandbox
  → Daemon registers with server (ephemeral host)
  → Server sends environment.provision command (clone repo, setup)
  → Environment is ready, thread can start

Host idle (no active threads) for >15 min:
  → Server sends workspace.checkpoint command (commit + push branch)
  → Server suspends host (sandbox.pause())
  → Host status: suspended

New command for suspended host:
  → Server resumes host (Sandbox.resume() or recreate + clone from remote)
  → Daemon reconnects
  → Server delivers command

Thread archived / environment destroyed:
  → Server destroys host (sandbox.kill())
```

### Host statuses

```
connected → disconnected (WS drop + lease timeout)
connected → suspended (cloud only, idle timeout)
suspended → connected (resume on command)
```

`suspended` is a host status, not an environment status. The environment is still `ready` — the machine is paused.

---

## How Commands Flow

### Creating a thread with a new environment

**Existing path:**
```
App → POST /threads { path, hostId }
Server → creates environment record optimistically (status: ready), creates thread, queues thread.start
Daemon → runs thread.start; if path is bad, reports error
Server → if error: marks environment as error, thread as error
```

**Managed worktree:**
```
App → POST /threads { provisionerId: "worktree", hostId }
Server → creates environment record (status: provisioning), creates thread (status: provisioning)
Server → queues environment.provision command with { mode: "worktree", sourcePath, targetPath, branchName }
Daemon → calls createWorktree() + runSetupScript() from @bb/workspace
Daemon → reports command-result with { path, isGitRepo: true }
Server → updates environment (status: ready, path), transitions thread to idle
Server → queues thread.start if pending input
```

**E2B sandbox:**
```
App → POST /threads { provisionerId: "e2b" }
Server → calls E2B API to create sandbox (server-side)
Server → starts daemon inside sandbox, waits for registration
Server → creates host record (ephemeral), environment record (status: provisioning)
Server → queues environment.provision command to sandbox's daemon { mode: "clone", repoUrl, branchName }
Daemon (inside sandbox) → calls createClone() + runSetupScript() from @bb/workspace
Daemon → reports result
Server → updates environment (status: ready), queues thread.start
```

### Workspace operations

```
App → POST /environments/:id/actions { type: "commit", message: "fix bug" }
Server → resolves environment path from DB
Server → queues workspace.commit command { path, message, includeUnstaged: true }
Daemon → workspace.commit(options) on Workspace instance
Daemon → reports command-result with { sha, subject }
Server → creates system event, notifies app via WS
```

### Promote

```
App → POST /environments/:id/actions { type: "promote" }
Server → identifies source env (thread's host) and target (user's primary checkout host)
Server → queues workspace.export to source daemon
Source daemon → returns changeset { type: "branch", branch: "bb/env-abc" }
Server → queues workspace.import to target daemon with changeset + primaryPath
Target daemon → stash, checkout branch → returns { previousBranch, stashRef }
Server → stores promote state (previousBranch, stashRef) for demote
```

---

## Non-Git Environments

bb works with any directory. If the environment's `isGitRepo` is false:
- Thread runs normally — agent writes code, runs commands
- Server doesn't send workspace commands for non-git environments
- UI shows the thread without the git panel

---

## What Lives Where

| Code | Package/Location |
|---|---|
| `Workspace` class, provisioning functions | `@bb/workspace` |
| Promote/demote orchestration (export/import/reattach) | `apps/host-daemon` (daemon composes Workspace primitives) |
| E2B sandbox create/suspend/resume/destroy | `apps/server` |
| Host registration, identity, heartbeat | `apps/host-daemon` |
| Command routing, AgentRuntime management | `apps/host-daemon` |
| Environment DB records, thread lifecycle, command queuing | `apps/server` |
| Workspace types (WorkspaceStatus, DiffResult, etc.) | `@bb/domain` |

---

## Appendix

### A. Squash-Merge Implementation

Git prevents checking out a branch already checked out in another worktree. `squashMergeInto` handles this with a temporary worktree:

```bash
git worktree add /tmp/bb-merge-<random> <targetBranch>
cd /tmp/bb-merge-<random>
git merge --squash <currentBranch>
git commit -m "<commitMessage>"
cd -
git worktree remove /tmp/bb-merge-<random>
```

### B. Git Worktree Constraints

- Two worktrees cannot check out the same branch
- Commits in worktree A visible in worktree B immediately (shared objects)
- Concurrent git operations in different worktrees are safe
- `git worktree remove` refuses with uncommitted changes (use `--force`)
- No practical worktree count limit
- `git gc` is worktree-aware

### C. E2B Patterns (from terragon)

**v1 cardinality: one sandbox = one host = one environment.** Idle detection is host-scoped.

- Blobless clone (`--filter=blob:none`) for speed
- Git credentials via `.git-credentials` file
- Sandbox timeout 15 min, extended on each event
- Checkpoint = commit + push before suspend
- Resume = `Sandbox.resume()` + refresh credentials
- If resume fails, recreate + clone from remote branch

### D. Environment Strategies Summary

| Strategy | Managed? | Provisioned by | `@bb/workspace` used for |
|---|---|---|---|
| Existing path | No | Server (optimistic) | `Workspace` git operations |
| Worktree | Yes | Daemon | `createWorktree`, `runSetupScript`, `removeWorktree`, `Workspace` operations |
| Clone | Yes | Daemon | `createClone`, `runSetupScript`, `removeDirectory`, `Workspace` operations |
| E2B sandbox | Yes | Server (host) + Daemon (workspace) | `createClone`, `runSetupScript`, `Workspace` operations, `checkpoint` |
