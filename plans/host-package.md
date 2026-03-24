# `@bb/workspace` + `@bb/sandbox-host` Package Plan

Two packages, genuinely different concerns. The daemon never imports `@bb/sandbox-host`. The server never imports `@bb/workspace`.

## `@bb/workspace`

**What it owns:** workspace provisioning and operations. Used by the daemon. Doesn't know or care what kind of host it's running on.

**Dependencies:** `@bb/domain`, filesystem, git. No network, no DB.

### External interface

```typescript
function provisionWorkspace(opts: ProvisionWorkspaceOpts): Promise<IWorkspace>;

interface IWorkspace {
  // Discovered properties (snapshot at provision time)
  path: string;
  managed: boolean;
  isGitRepo: boolean;
  isWorktree: boolean;

  // Git queries
  currentBranch(): Promise<string | null>;
  getStatus(): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  getBranches(): Promise<string[]>;

  // Git mutations
  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  checkpoint(options: CheckpointOptions): Promise<CheckpointResult>;
  squashMergeInto(options: SquashMergeOptions): Promise<SquashMergeResult>;

  // Promote/demote
  promote(primary: IWorkspace, options?: { remote?: string }): Promise<void>;
  demote(primary: IWorkspace, defaultBranch: string): Promise<void>;

  // Lifecycle
  destroy(): Promise<void>;  // managed: remove worktree/dir. unmanaged: no-op.
}
```

`provisionWorkspace` handles all provisioning types:
- **unmanaged**: validates path, discovers properties. No creation, no cleanup. Synchronous-fast.
- **worktree**: creates git worktree + branch, runs setup script. `destroy()` removes it. May take minutes.
- **clone**: clones repo, creates branch, runs setup script. `destroy()` removes it. May take minutes.

Provisioning is all-or-nothing — if setup script fails, the worktree/clone is cleaned up before the error propagates. `IWorkspace` is never returned in a partially-provisioned state.

Git methods throw if `!isGitRepo`. The server knows `isGitRepo` from the environment record and shouldn't send workspace commands to non-git environments.

### What changes from today

Today's `@bb/workspace` exports raw primitives (`Workspace` class, `createWorktree`, `removeWorktree`, `promoteWorkspace`, etc.) and callers assemble them. The new version wraps these behind `provisionWorkspace() → IWorkspace`. Callers get a ready-to-use object. Internals stay mostly the same.

### Open questions

**Q1: `provisionWorkspace` opts shape?** Needs: provisioning type (unmanaged/worktree/clone), path or source path, branch name, setup script config, progress callback. Probably a discriminated union on provisioning type.

**Q2: Promote/demote — method or standalone?** Proposed as `workspace.promote(primary)`. Alternative: standalone `promote(source, primary)`. Trade-off: methods read naturally and `IWorkspace` knows its own branch name (no `envBranch` param needed for demote). But promote/demote operate on two workspaces equally — having it as a method on one is slightly misleading about ownership.

**Q3: Concurrency.** Git operations on the same worktree are not safe to run in parallel. Is serialization the caller's responsibility (daemon's per-environment queue) or the package's? Leaning caller — the daemon already has per-environment serialization in the command router.

---

## `@bb/sandbox-host`

**What it owns:** ephemeral host lifecycle. Used by the server. The daemon running inside an ephemeral host is a normal daemon — it uses `@bb/workspace` like any other daemon.

**Dependencies:** `@bb/domain`, E2B SDK. No filesystem (operates via cloud API).

### External interface

```typescript
function provisionHost(opts: ProvisionHostOpts): Promise<ISandboxHost>;
function resumeHost(sandboxId: string, opts: ResumeHostOpts): Promise<ISandboxHost>;

interface ISandboxHost {
  id: string;            // bb host ID (stored in hosts table)
  externalId: string;    // E2B sandbox ID (stored in hosts.externalId)
  name: string;

  suspend(): Promise<void>;   // snapshot/pause VM
  resume(): Promise<void>;    // restore/unpause VM
  destroy(): Promise<void>;   // tear down VM
}
```

`provisionHost` creates a new sandbox:
1. Create E2B sandbox
2. Install daemon bundle into sandbox (write files, run commands — internal detail)
3. Start daemon
4. Wait for daemon to connect back to server via normal session protocol
5. Return `ISandboxHost` for lifecycle management

`resumeHost` restores a suspended sandbox (server has the `externalId` from the hosts table).

Everything between steps 1–4 is internal to the package. From the server's perspective: call `provisionHost`, wait, get back a handle. After that, the server talks to the daemon through the normal session/command/event protocol — `ISandboxHost` is only for suspend/resume/destroy.

Workspace provisioning inside the sandbox goes through the normal path: server sends `environment.provision` command → daemon calls `provisionWorkspace()` from `@bb/workspace`. This keeps the daemon uniform across host types.

### What we're porting

~185 lines of E2B-specific code from [terragon-oss](https://github.com/terragon-labs/terragon-oss), plus ~350 lines of provider-agnostic setup (git clone, branch creation, daemon install, setup scripts). E2B SDK: `@e2b/code-interpreter`.

### Open questions

**Q1: How does `provisionHost` know the daemon has connected?** It needs a callback or a way to wait for the daemon's session open. Options: pass the server URL and a callback, poll the server, or return the host eagerly and let the server wait for the session separately.
