# Platform Support Decision Record

## Milestone Support Matrix

### Milestone 1: Shared Foundation + Linux Support

- Linux persistent host:
  - supported for install, build, typecheck, test, app/server/host-daemon
    startup, and local-path + managed-workspace product flows
- Windows:
  - preflight only for `pnpm install`, `pnpm build`, and `pnpm typecheck`
  - runtime, workspace, and local project UX are not yet claimed as supported
- macOS persistent host:
  - remains supported as an existing product path
- E2B sandboxes:
  - Linux-only

### Milestone 2: Windows Support + Final Hardening

- Linux persistent host:
  - remains fully supported
- Windows persistent host:
  - supported for install, build, typecheck, test, app/server/host-daemon
    startup, and local-path + managed-workspace product flows
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
- provider runtime startup where the provider itself supports the host OS

### Maintainer-only or best-effort surfaces

- ad hoc Unix-only QA helpers under [`scripts/qa/`](/Users/michael/.codex/worktrees/50a3/bb/scripts/qa)
- dev restart internals that are not part of the shipped product path
- sandbox execution on Windows

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
- `.bb-env-setup.sh` is not part of the supported Windows contract and is not
  part of Milestone 1 or Milestone 2 exit criteria.

## Line Ending Policy

- The repository enforces LF checkout for supported text files via
  [.gitattributes](/Users/michael/.codex/worktrees/50a3/bb/.gitattributes).
- Supported Linux and Windows flows must work from a default Windows Git
  checkout with those repository rules applied.

