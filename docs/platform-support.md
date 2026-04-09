# Platform Support

## Supported host environments

- macOS persistent host
- Linux persistent host
- Windows via Ubuntu on WSL2

Windows support means the Linux stack runs entirely inside WSL2:

- all `bb` processes run inside the same Ubuntu WSL2 distro
- Node.js, pnpm, Git, and provider CLIs are installed inside WSL2
- local project paths use Linux-style absolute paths from inside WSL2
- native Windows PowerShell, CMD, drive-letter paths, and UNC paths are not
  supported product paths

## Support Boundaries

### Supported product flows

- `pnpm install`
- `pnpm exec turbo run build`
- `pnpm exec turbo run typecheck`
- `pnpm exec turbo run test`
- app + server + host-daemon startup on supported persistent-host OSes
- local-path project creation and update in the app
- unmanaged environments
- managed clone/worktree environments
- provider runtime startup where the provider itself supports the host
  environment

### WSL2-specific expectations

- Run `pnpm install`, `pnpm start`, `pnpm dev`, `pnpm bb:dev`, and host-daemon
  commands from a WSL2 shell, not from native Windows terminals.
- Repositories inside the WSL filesystem are recommended for best behavior.
- `/mnt/c/...` mounted paths are deliberately supported so WSL2 users can keep
  working with existing Windows checkouts instead of relocating every repo into
  the WSL filesystem, but they are a tradeoff:
  slower filesystem I/O and weaker file-watching behavior than the WSL
  filesystem.
- Native Windows drive-letter and UNC paths are rejected at the app/server
  boundary so unsupported input fails clearly.

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
- No parallel `.bb-env-setup.ts` product-path mechanism is supported.

## Line Ending Policy

- The repository enforces LF checkout for supported text files via
  [.gitattributes](../.gitattributes).
- Supported Linux and WSL2 flows must work with those repository rules applied.
- Native Windows checkouts are outside the support contract unless we later
  choose to support a native Windows product path.

## CI And Validation

- GitHub Actions uses Ubuntu as the required support gate for build,
  typecheck, lint, test, and Linux smoke coverage.
- Native Windows CI is intentionally not required because Windows support uses
  the Linux runtime path inside WSL2 rather than a separate native Windows
  product path.
