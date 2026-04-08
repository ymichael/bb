# Linux and Windows Compatibility Plan

## Goal

Make bb explicitly support Linux and Windows for local development and
persistent-host runtime flows, with CI and test coverage that prevents regressions.
Use a small, documented set of cross-platform third-party packages where that
reduces maintenance versus homegrown OS-specific wrappers.

## Support Target

### In scope

- `pnpm install`
- `pnpm exec turbo run build`
- `pnpm exec turbo run typecheck`
- `pnpm exec turbo run test`
- app + server + host-daemon startup on Linux and Windows
- local/persistent host flows for:
  - creating and updating local-path projects
  - unmanaged environments
  - managed clone/worktree environments
  - provider runtime startup (`codex`, `claude-code`, `pi`) where the provider
    itself is installed on the host OS

### Out of scope unless we choose otherwise during implementation

- making E2B sandboxes themselves run on Windows
- preserving shell-script setup hooks as the only setup mechanism
- ad hoc Unix-only QA helpers that are not part of the supported product path

## Current Blockers

### Packaging and dev scripts are not cross-platform

- Root scripts rely on inline env assignment in
  [package.json](/Users/michael/.codex/worktrees/50a3/bb/package.json).
- Many package `build` / `clean` scripts rely on `rm -rf`, `mkdir -p`, and `cp`,
  including [package.json](/Users/michael/.codex/worktrees/50a3/bb/package.json),
  [apps/host-daemon/package.json](/Users/michael/.codex/worktrees/50a3/bb/apps/host-daemon/package.json),
  and [packages/agent-runtime/package.json](/Users/michael/.codex/worktrees/50a3/bb/packages/agent-runtime/package.json).
- We do not yet have a documented cross-platform dependency strategy, which
  makes it too easy to fix each script or launcher ad hoc.

### Windows checkout and process contracts are not defined

- The repo does not yet define a line-ending policy for supported source files,
  scripts, or hooks in
  [.gitattributes](/Users/michael/.codex/worktrees/50a3/bb/.gitattributes).
- Portability-sensitive launch paths still rely on raw `child_process.spawn(...)`
  in
  [packages/agent-runtime/src/runtime.ts](/Users/michael/.codex/worktrees/50a3/bb/packages/agent-runtime/src/runtime.ts),
  [apps/host-daemon/src/local-api.ts](/Users/michael/.codex/worktrees/50a3/bb/apps/host-daemon/src/local-api.ts),
  and
  [packages/host-workspace/src/provisioning.ts](/Users/michael/.codex/worktrees/50a3/bb/packages/host-workspace/src/provisioning.ts),
  but the repo does not yet define how `.cmd`, `.bat`, and `.exe` launch
  semantics should work on Windows.

### Host-daemon runtime assumes Unix launcher semantics

- The local `bb` launcher is a POSIX shell script in
  [apps/cli/bin/bb](/Users/michael/.codex/worktrees/50a3/bb/apps/cli/bin/bb).
- The host daemon checks POSIX executable bits and prepends `PATH` with `:`
  in [apps/host-daemon/src/runtime-shell-env.ts](/Users/michael/.codex/worktrees/50a3/bb/apps/host-daemon/src/runtime-shell-env.ts).

### Managed workspace setup is POSIX-only

- Setup hooks run via `/bin/bash` in
  [packages/host-workspace/src/provisioning.ts](/Users/michael/.codex/worktrees/50a3/bb/packages/host-workspace/src/provisioning.ts).

### Local host UX is incomplete off macOS

- Folder picking is macOS-only in
  [apps/host-daemon/src/local-api.ts](/Users/michael/.codex/worktrees/50a3/bb/apps/host-daemon/src/local-api.ts).

### Windows path handling has correctness and security bugs

- Attachment path containment uses a POSIX string-prefix check in
  [apps/server/src/services/projects/attachments.ts](/Users/michael/.codex/worktrees/50a3/bb/apps/server/src/services/projects/attachments.ts).
- Project-name derivation splits only on `/` in
  [apps/app/src/lib/projectPathInput.ts](/Users/michael/.codex/worktrees/50a3/bb/apps/app/src/lib/projectPathInput.ts).

### Process management and test harnesses are Unix-heavy

- Dev restart uses `SIGUSR1` in
  [scripts/request-dev-restart.mjs](/Users/michael/.codex/worktrees/50a3/bb/scripts/request-dev-restart.mjs).
- Integration cleanup depends on `lsof` and `SIGKILL` in
  [tests/integration/global-setup.ts](/Users/michael/.codex/worktrees/50a3/bb/tests/integration/global-setup.ts).

### CI does not protect compatibility

- CI only runs on Ubuntu in
  [.github/workflows/ci.yml](/Users/michael/.codex/worktrees/50a3/bb/.github/workflows/ci.yml).

## Plan

### Phase 1: Define the platform contract

1. Decide the official support matrix:
   - Linux persistent host: supported
   - Windows persistent host: supported
   - macOS persistent host: keep supported
   - E2B sandbox runtime: Linux-only unless explicitly expanded
2. Document which features are expected to work on each OS.
3. Split supported product flows from Unix-only maintainer tooling so we do not
   block the main rollout on QA helper scripts.
4. Decide the dependency policy for cross-platform maintenance:
   - prefer a small shared package set over many repo-local one-off scripts
   - keep packages at true boundaries: env injection, filesystem shell helpers,
     process launch, and OS open/folder-picker integration
   - wrap package usage behind repo-local helpers when the package would
     otherwise leak through many call sites
5. Make an explicit package decision record for the rollout:
   - adopt `cross-env` for portable env assignment in package scripts
   - adopt `rimraf` for portable recursive cleanup
   - adopt `open` for OS-specific file and URL opening
   - adopt `cross-spawn` for portability-sensitive subprocess launch, because
     the current runtime code is already `spawn`-oriented and Windows command
     shim resolution is the main gap we need to close
   - do not adopt `shx`; use small Node scripts for file-copy and
     directory-creation script logic instead
   - avoid adding packages for path normalization or generic filesystem helpers
     where `node:path` and `fs/promises` already cover the need
6. Decide and document the setup-hook migration policy:
   - the supported end state is a Node-based `.bb-env-setup.ts`
   - `.bb-env-setup.sh` may exist only as a short-lived Unix-only migration
     bridge during rollout
   - `.bb-env-setup.sh` is not part of the supported Windows contract or final
     exit criteria
7. Decide and document repository checkout policy:
   - add `.gitattributes` rules for predictable LF handling in supported source
     files, shell scripts, and setup hooks
   - validate supported flows against a default Windows Git checkout

**Validation**

- A decision record exists under `plans/` or `docs/` and lists:
  - the supported OS matrix
  - maintainer-only or best-effort exclusions
  - the chosen package set and rationale
  - the setup-hook end state and any temporary migration bridge
  - the line-ending policy and default Windows checkout expectations
- Product documentation clearly distinguishes supported flows from maintainer
  tooling and best-effort surfaces

### Phase 2: Make packaging, checkout, and critical security paths cross-platform

1. Replace inline env assignments with a cross-platform mechanism:
   - `cross-env` for package scripts
   - small Node entrypoint scripts only when a script needs more than env
     injection
2. Replace `rm -rf`, `mkdir -p`, and `cp` in package scripts with:
   - `rimraf` for recursive cleanup
   - repo-local Node scripts for copy/create-directory logic
3. Standardize the script layer so the same package choices are reused across
   the repo instead of mixing multiple approaches package by package.
4. Fix the attachment containment bug before expanding Windows runtime coverage:
   - replace string-prefix checks with `path.relative`-based containment
   - add targeted traversal tests for both POSIX and Windows-style paths
5. Define and implement repository line-ending policy:
   - add `.gitattributes` entries for supported text and script files
   - normalize any cross-platform parsing that currently assumes a checked-out
     script or fixture will always be LF-terminated
6. Remove assumptions that `pnpm`, `node`, or provider CLIs are launched through
   POSIX shell parsing.
7. Add an automated preflight CI job on `ubuntu-latest` and `windows-latest`
   that runs install/build/typecheck before Phase 8 expands to full smoke
   coverage.
8. Keep Turbo as the only supported task runner path.

**Validation**

- `pnpm install`
- `pnpm exec turbo run build --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli`
- `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/host-workspace --filter=@bb/agent-runtime --filter=@bb/db`
- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/app`
- Preflight CI is green on `ubuntu-latest` and `windows-latest` for install,
  build, and typecheck
- Attachment reads reject traversal correctly on both POSIX and Windows-style
  paths

### Phase 3: Fix host-daemon, CLI launcher, and Windows spawn portability

1. Replace the POSIX-only `bb` launcher contract with a cross-platform one:
   - either a generated Windows launcher alongside the Unix script
   - or a Node-based entrypoint that the host daemon can reference directly
2. Change runtime shell env construction to use `path.delimiter` instead of `:`.
3. Stop using Unix executable-bit checks as the gate for CLI availability on
   Windows.
4. Standardize the child-process launch contract:
   - route portability-sensitive launches through a shared helper backed by
     `cross-spawn`
   - make that helper responsible for `.cmd`, `.bat`, `.exe`, and POSIX binary
     resolution
   - do not rely on raw `spawn(..., { shell: false })` for Windows command shims
     or on `shell: true` as a blanket workaround
5. Make provider process launch robust on Windows:
   - verify Codex startup via `codex` / shim resolution
   - verify Node bridge startup for Claude Code and Pi
   - verify at least one shim-installed provider on Windows
6. Keep the shared launch helper isolated so process-launch semantics stay
   consistent and easy to test.

**Validation**

- `pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/agent-runtime`
- Manual:
  - start host daemon on Linux and Windows
  - confirm provider startup succeeds for at least one installed provider
  - confirm `bb` is available inside a thread runtime shell

### Phase 4: Replace the setup-hook contract with a cross-platform mechanism

1. Define the supported environment-setup contract:
   - documented end state: Node-based `.bb-env-setup.ts`
   - if we need a migration bridge, `.bb-env-setup.sh` runs only on POSIX and is
     explicitly temporary
2. Update workspace provisioning to use that contract instead of `/bin/bash`.
3. Update transcript output to reflect the actual command or hook used.
4. Update tests and fixtures that currently hardcode `/bin/bash .bb-env-setup.sh`.
5. Define and validate Windows behavior for repositories that contain symlinks in
   managed clone/worktree flows:
   - if host Git symlink support is required, detect that case and surface a
     clear unsupported-host error
   - otherwise document the supported behavior and test it

**Validation**

- `pnpm exec turbo run test --filter=@bb/host-workspace --filter=@bb/host-daemon`
- Manual:
  - provision managed clone/worktree on Linux
  - provision managed clone/worktree on Windows from a default Git checkout
  - confirm timeout and failure reporting still works
  - verify the documented behavior for a repository that contains symlinks on
    Windows

### Phase 5: Fix local host UX on Linux and Windows

1. Add a Linux/Windows implementation for folder picking, or when native
   selection is unavailable expose an app-side validated absolute-path text
   input; do not require a CLI-only workaround.
2. Keep `open-path` working on Linux and Windows with graceful error handling if
   the OS helper is missing.
3. Ensure project creation and source updates from the app work on all supported
   persistent-host OSes.

**Validation**

- `pnpm exec turbo run test --filter=@bb/app --filter=@bb/host-daemon`
- Manual:
  - create a local-path project from the app on Linux
  - create a local-path project from the app on Windows
  - update an existing local-path source from the app on both OSes

### Phase 6: Sweep remaining path handling and OS-sensitive correctness bugs

1. Introduce shared path helpers only where at least two callers justify reuse;
   otherwise fix locally:
   - basename extraction from either slash style
   - normalized display formatting when UI wants forward slashes
   - path containment helpers only if they are needed beyond the earlier
     attachment fix
2. Fix the remaining audited path issues:
   - project-name derivation
   - any path joins built with string interpolation
   - any Windows-path display or round-trip bugs found during earlier phases
3. Add targeted tests with Windows-style input paths even when running on
   non-Windows CI.

**Validation**

- `pnpm exec turbo run test --filter=@bb/app --filter=@bb/server --filter=@bb/ui-core --filter=@bb/core-ui`
- Manual:
  - verify Windows-style local paths round-trip through the app and server
  - verify path-derived UI labels remain correct for both POSIX and Windows paths

### Phase 7: Make process management and test infrastructure portable

1. Replace or isolate Unix-only test cleanup code (`lsof`, signal assumptions).
2. Replace dev-supervisor restart signaling with a cross-platform control path:
   - PID file + local control socket/HTTP endpoint, or
   - file-based restart requests
3. Move Unix-specific QA helpers behind explicit Linux/macOS-only tooling if they
   are not part of the supported product path.

**Validation**

- `pnpm exec turbo run test --filter=@bb/integration-tests`
- Manual:
  - restart dev server and host-daemon through the supported flow on Linux
  - restart dev server and host-daemon through the supported flow on Windows

### Phase 8: Add compatibility CI and smoke coverage

1. Expand the earlier install/build/typecheck preflight into a full OS matrix:
   - `ubuntu-latest`
   - `windows-latest`
   - `macos-latest` for host-local API coverage if cost is acceptable
2. Split jobs so failures are attributable:
   - install/build/typecheck
   - unit tests
   - smoke tests for server + host-daemon startup
3. Add a small smoke suite that verifies:
   - server starts
   - host daemon starts
   - local API health responds
   - unmanaged environment path works
   - local-path project creation path works

**Validation**

- CI matrix is green on all supported OSes for:
  - install
  - build
  - typecheck
  - tests
  - smoke

### Phase 9: Document support and operating procedures

1. Update README with supported OSes and any intentional Linux-only surfaces.
2. Document required host prerequisites per OS:
   - Git
   - Node / pnpm
   - provider CLI installation expectations
3. Document known limitations that remain after rollout.

**Validation**

- Docs include:
  - supported OS matrix
  - startup instructions for Linux and Windows
  - any explicitly unsupported flows

## Exit Criteria

- [ ] A Phase 1 decision record documents the supported OS matrix, minimal
      dependency set, setup-hook policy, and Windows line-ending expectations
- [ ] `pnpm install`, `pnpm exec turbo run build`, `pnpm exec turbo run typecheck`,
      and `pnpm exec turbo run test` succeed on Linux and Windows in CI
- [ ] Cross-platform maintenance uses a documented, minimal dependency set
      instead of package-by-package custom shell fixes
- [ ] Host daemon starts successfully on Linux and Windows for persistent-host
      flows
- [ ] Portability-sensitive process launches use the shared launch helper and no
      supported Windows flow depends on raw `.cmd` / `.bat` spawn behavior
- [ ] Provider runtime startup works on Linux and Windows for at least one
      installed provider, and the launch path is no longer Unix-specific
- [ ] Managed environment setup no longer depends on `/bin/bash`, and symlink-
      related Windows limitations are either supported or surfaced as explicit
      host errors
- [ ] App-based local project creation/update works on Linux and Windows, either
      through native folder picking or a supported fallback
- [ ] The repo enforces a line-ending policy that keeps supported flows working
      on default Windows Git checkouts
- [ ] Attachment containment and path-derived UI behavior are correct for Windows
      and POSIX paths
- [ ] CI includes Linux and Windows coverage for build, typecheck, tests, and
      smoke startup
- [ ] README documents the supported OS matrix and any intentional exceptions

## Risks and Decisions

### Setup hook migration

The supported end state is `.bb-env-setup.ts`. If a migration bridge is needed
for existing repositories, keep `.bb-env-setup.sh` Unix-only, explicitly
temporary, and out of the final Windows support contract and exit criteria.

### Provider availability on Windows

bb can only support providers that themselves support Windows. We should define
product behavior when a provider is unavailable on a host OS:

- hide it from recommendations where possible
- return a clear host-local error when selected anyway

### Linux-only sandbox surfaces

If sandbox execution remains Linux-only, that should be a documented product
decision, not an accidental implication of the implementation.

### Windows checkout and symlink behavior

Supported flows need to survive a default Windows Git checkout:

- `.gitattributes` must enforce predictable line endings for supported source
  files and scripts
- managed clone/worktree flows must either support repositories that contain
  symlinks or detect the limitation and return a clear unsupported-host error

### Third-party package footprint

We should be deliberate about adding dependencies. The planned set is:

- `cross-env`
- `rimraf`
- `open`
- `cross-spawn`

We will still keep usage constrained:

- add packages only where they remove repeated OS branching or fragile shell
  behavior
- prefer one package per concern instead of overlapping utilities
- keep package usage behind shared helpers when the concern is part of product
  runtime rather than package-script plumbing
- pin current maintained releases and re-evaluate the set if a package becomes
  unmaintained or security-sensitive

## Execution Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9

This order fixes the security-sensitive path handling and build/check-out
foundations first, then makes runtime setup and app UX portable, then locks the
result in with CI and documentation.
