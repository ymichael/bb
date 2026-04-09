# Platform Support Decision Record

## Milestone Support Matrix

### Milestone 1: Shared Foundation + Linux Support

- Linux persistent host:
  - supported for install, build, typecheck, test, app/server/host-daemon
    startup, and local-path + managed-workspace product flows
- Windows:
  - native Windows is not a supported product path
  - Windows users are expected to run bb inside Ubuntu on WSL2 once Milestone 2
    is complete
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
  - native Windows drive-letter and UNC paths are outside the supported product
    path

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

- The supported setup hook is POSIX `.bb-env-setup.sh`.
- The same shell-based hook contract is used across macOS, Linux, and WSL2.
- `.bb-env-setup.ts` is not part of the supported contract and should be
  removed from the product path to avoid parallel setup mechanisms.

## Line Ending Policy

- The repository enforces LF checkout for supported text files via
  [.gitattributes](../.gitattributes).
- Supported Linux and WSL2 flows must work with those repository rules applied.
- Native Windows checkouts are outside the support contract unless we later
  choose to support a native Windows product path.
