<!-- Diátaxis: reference -->

# Platform Support

## Supported host environments

- macOS persistent host
- Linux persistent host
- Windows via Ubuntu on WSL2

Minimum runtime: Node.js 22.19. Pi no longer sets the floor: its bridge is a
plugin and the `pi` CLI is user-installed like `codex` and `claude`, so the
22.19 line is bb's own tested floor (`install-machine.sh` and the root
`engines` gate on it). A lower floor needs its own test pass before it moves.

Tested npm package runtimes:

- Node.js 22.19 or newer in the Node.js 22 release line
- Node.js 24 LTS
- Node.js 26 Current

Newer release lines are not blocked. `install-machine.sh` gates on the 22.19
floor only, so a release line we have not tested yet still installs rather than
failing hard on the day it ships. The `bb-app` npm `engines` field lists the
tested lines, which npm surfaces as a warning rather than an install failure.

Windows support means the Linux stack runs entirely inside WSL2:

- all `bb` processes run inside the same Ubuntu WSL2 distro
- Node.js, Git, provider CLIs, and pnpm for source-development flows are
  installed inside WSL2
- local project paths use Linux-style absolute paths from inside WSL2
- native Windows PowerShell, CMD, drive-letter paths, and UNC paths are not
  supported product paths

## Mobile app

[`apps/mobile`](../apps/mobile) is a native phone client for a bb server
(Expo / React Native). It runs no agents, host daemon, or plugins itself; it
talks to a server over the same HTTP + WebSocket contract as the web app.

- Platforms: iOS first (iPhone; iPad runs the phone layout). Android is
  planned next; the code is platform-neutral but no Android build has been
  produced or tested yet.
- Connecting: **Direct** mode takes any `http(s)://` URL the phone can reach
  (the iOS Simulator's `http://127.0.0.1:<port>`, a LAN address with
  `--server-bind-host 0.0.0.0`, a Tailscale Serve HTTPS URL). It is
  unauthenticated, the same trust model as the browser PWA on a LAN; iOS
  allows plain `http://` only for LAN IPs and `.local` names, so Tailscale
  hosts need Serve HTTPS. **bb connect** mode pairs the phone as a connect
  machine (QR / code from Settings → Remote access or
  `bb connect machine-code`, both behind the `mobileApp` experiment during
  early access), keeps the credential in the device keychain, and mints
  short-lived sessions; see [multiple-devices.md](multiple-devices.md).
- Distribution: developer builds from source (Xcode 26.2, iOS 26 simulator
  runtime) today; TestFlight / Play builds go through EAS once the Expo
  account exists (see `apps/mobile/README.md`). No store release yet.
- The built-in Push notifications plugin works on iOS when the bb server can
  reach `exp.host`. The server needs no Apple or Google keys. Android push
  support remains untested.

Not available on the phone (use the web app or desktop for these):

- Plugin **frontends**: nav panels (Automations, Tasks, Docs, GitHub), DOM
  `settingsSection` pages (connect Remote access, memory, custom
  instructions, keep-awake), composer customization, message-action callbacks,
  content scripts, side-chat panels. Plugin backends (tools, CLI, mentions,
  declarative settings, pending-interaction forms for `ask-user-question` and
  `secrets`) work.
- Provider sign-in (`codex login`, `claude /login`): still needs a terminal on
  the host; the phone assumes a signed-in host.
- Local editor integration, "Open in …", native folder picker, local daemon
  features: phones have no host daemon. The remote path browser works.
- Custom CSS themes and plugin themes: only the built-in palettes map to the
  native tokens.
- Splits, drag reorder, the keyboard shortcut editor, desktop browser
  automation. Text-selection quoting is per paragraph. KaTeX / Mermaid render
  as source; video files open outside the app.

## Support Boundaries

### Supported product flows

- `npx bb-app`
- `npx --package bb-app bb ...`
- source checkout package startup with `pnpm start`, `pnpm start:worktree`, or
  `pnpm start:worktree-remote`
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
- The supported teardown hook is POSIX `.bb-env-teardown.sh`.
- The same shell-based hook contract is used across macOS, Linux, and WSL2.
- No parallel `.bb-env-setup.ts` product-path mechanism is supported.
- The `.worktreeinclude` copy step runs no shell. It works on every platform,
  including native Windows.

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
  smoke on Ubuntu and macOS with Node.js 24 and 26.
- Branch protection should require `Checks (ubuntu-latest, Node 22.x)`,
  `Package Smoke (ubuntu-latest, Node 22.x)`, and
  `Package Smoke (macos-latest, Node 22.x)`. The Node.js 24 and 26 compatibility
  smoke jobs do not run on pull requests and should not be configured as
  required PR checks.
- Native Windows CI is intentionally not required because Windows support uses
  the Linux runtime path inside WSL2 rather than a separate native Windows
  product path.
- `apps/mobile` typecheck, lint, and unit tests run inside the Ubuntu
  `Checks` and `Tests (packages)` jobs like every other workspace package. The
  iOS simulator Maestro flows run in `Mobile E2E`
  (`.github/workflows/mobile-e2e.yml`) on the macOS runner only when a pull
  request carries the `mobile-e2e` label, nightly on `main`, or on manual
  dispatch; they are not a required check.
