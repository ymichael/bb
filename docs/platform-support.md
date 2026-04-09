# Platform Support Decision Record

## Milestone Support Matrix

### Milestone 1: Shared Foundation + Linux Support

- Linux persistent host:
  - supported for install, build, typecheck, test, app/server/host-daemon
    startup, and local-path + managed-workspace product flows
- Windows:
  - native Windows is not a supported product path
  - optional `windows-latest` CI preflight may remain as an early-warning signal
    for script portability, but it is not a support gate
- macOS persistent host:
  - remains supported as an existing product path
- E2B sandboxes:
  - Linux-only

### Milestone 2: Windows via WSL2 Support + Final Hardening

- Linux persistent host:
  - remains fully supported
- Windows via WSL2 persistent host:
  - supported when all `bb` processes run inside Ubuntu on WSL2
  - supported for install, build, typecheck, test, app/server/host-daemon
    startup, and local-path + managed-workspace product flows inside WSL2
  - native Windows PowerShell and CMD execution remain unsupported
- macOS persistent host:
  - remains supported

## Support Boundaries

### Supported product flows

- `pnpm install`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- app + server + host-daemon startup on supported persistent-host OSes
- local-path project creation and update in the app
- unmanaged environments
- managed clone/worktree environments
- provider runtime startup where the provider itself supports the host
  environment
- Windows support uses the Linux stack inside WSL2:
  - all `bb` processes run inside WSL2
  - provider CLIs are installed inside the supported WSL2 distro
  - local project paths are Linux-style absolute paths from inside WSL2
  - repositories should live inside the WSL filesystem unless we explicitly
    expand support later

### Maintainer-only or best-effort surfaces

- ad hoc Unix-only QA helpers under [`scripts/qa/`](../scripts/qa/)
- dev restart internals that are not part of the shipped product path
- sandbox execution on Windows
- native Windows PowerShell, CMD, and host-daemon runtime flows

## Dependency Policy

We are standardizing on a small set of cross-platform packages:

- `cross-env`
  - portable environment injection in package scripts
- `rimraf`
  - portable recursive cleanup in package scripts
- `cross-spawn`
  - shared subprocess launch for portability-sensitive runtime paths
- `open`
  - OS-specific file/URL opening behind a repo-local helper

We are explicitly not adopting:

- `shx`
  - we prefer small Node scripts for copy/create-directory logic
- generic path helper libraries
  - `node:path` is sufficient
- generic filesystem helper libraries
  - `fs/promises` is sufficient

## Setup Hook Policy

- The supported end state is a Node-based `.bb-env-setup.ts`.
- `.bb-env-setup.sh` is a temporary Unix-only migration bridge when needed for
  existing repositories.
- `.bb-env-setup.sh` is not part of the supported WSL2 contract and is not part
  of Milestone 1 or Milestone 2 exit criteria.

## Line Ending Policy

- The repository enforces LF checkout for supported text files via
  [.gitattributes](../.gitattributes).
- Supported Linux and WSL2 flows must work with those repository rules applied.
- Native Windows checkouts are best-effort only unless we later choose to
  support a native Windows product path.
