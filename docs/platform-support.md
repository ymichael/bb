# Platform Support

## Supported host environments

- macOS persistent host
- Linux persistent host
- Windows via Ubuntu on WSL2

Supported npm package runtimes:

- Node.js 22 LTS
- Node.js 24 LTS
- Node.js 26 Current
- Node.js 20 is best-effort only because it is end-of-life upstream

Windows support means the Linux stack runs entirely inside WSL2:

- all `bb` processes run inside the same Ubuntu WSL2 distro
- Node.js, Git, provider CLIs, and pnpm for source-development flows are
  installed inside WSL2
- local project paths use Linux-style absolute paths from inside WSL2
- native Windows PowerShell, CMD, drive-letter paths, and UNC paths are not
  supported product paths

## Support Boundaries

### Supported product flows

- `npx bb-app`
- `npx --package bb-app bb ...`
- source checkout package startup with `pnpm start`
- source checkout validation with `pnpm install`, `pnpm build`,
  `pnpm exec turbo run typecheck`, and `pnpm exec turbo run test`
- app + server + host-daemon startup on supported persistent-host OSes
- local-path project creation and update in the app
- unmanaged environments
- managed worktree environments
- provider runtime startup where the provider itself supports the host
  environment
- `npx bb-app` package startup on supported npm package runtimes
- `npx --package bb-app bb ...` CLI execution through the published package

### Command ownership and mode selection

- `@bb/config` is the only source of dev/prod defaults.
- Repo-root source-development commands such as `pnpm start`, `pnpm bb`,
  `pnpm bb:dev`, and `pnpm reset` are thin wrappers around local packages and
  scripts.
- Those wrappers set `NODE_ENV` explicitly so ambient shell state does not
  change which bb instance they target.
- Explicit `BB_*` values override the `NODE_ENV`-selected defaults.
- Process-to-process handoff, such as daemon-injected CLI environment, must use
  explicit `BB_*` values for the exact target instance instead of relying on
  mode defaults.

### WSL2-specific expectations

- Run `npx bb-app`, source checkout commands such as `pnpm install`,
  `pnpm dev`, `pnpm bb:dev`, and host-daemon commands from a WSL2 shell, not
  from native Windows terminals.
- Repositories inside the WSL filesystem are recommended for best behavior.
- `/mnt/c/...` mounted paths are deliberately supported so WSL2 users can keep
  working with existing Windows checkouts instead of relocating every repo into
  the WSL filesystem, but they are a tradeoff:
  slower filesystem I/O and weaker file-watching behavior than the WSL
  filesystem.
- Native Windows drive-letter and UNC paths are rejected at the app/server
  boundary so unsupported input fails clearly.

### Maintainer-only or best-effort surfaces

- workspace-owned QA helpers under [`tests/qa/`](../tests/qa/)
- dev restart internals that are not part of the shipped product path
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

### Native npm dependencies

The npm package keeps native add-ons as runtime dependencies instead of bundling
one platform-specific `.node` binary into bb's JavaScript artifacts. This lets
npm install the correct native artifacts on the target machine for packages such
as `better-sqlite3` and `@parcel/watcher`.

Known failure modes remain the normal native-addon ones:

- changing Node versions after install without reinstalling or rebuilding
- copying `node_modules` across operating systems, CPU architectures, or libc
  variants
- disabling package lifecycle scripts
- running on a platform where no prebuild exists and no local build toolchain is
  available

The recovery path after a Node/runtime change is to reinstall the package or
rebuild the native dependency, for example `npm rebuild better-sqlite3`.

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
- Full build, typecheck, lint, and test checks run on Ubuntu with Node.js 22
  only.
- Pull requests run the `bb-app` tarball smoke on Ubuntu and macOS with Node.js
  22, validating the packed npm artifact through `npx --package`.
- Pushes to `main` and manually dispatched CI runs also run the `bb-app` tarball
  smoke on Ubuntu and macOS with Node.js 24 and 26. Node.js 20 runs as a
  best-effort Ubuntu compatibility signal only.
- Branch protection should require `Checks (ubuntu-latest, Node 22.x)`,
  `Package Smoke (ubuntu-latest, Node 22.x)`, and
  `Package Smoke (macos-latest, Node 22.x)`. The Node.js 20, 24, and 26
  compatibility smoke jobs do not run on pull requests and should not be
  configured as required PR checks.
- Native Windows CI is intentionally not required because Windows support uses
  the Linux runtime path inside WSL2 rather than a separate native Windows
  product path.
