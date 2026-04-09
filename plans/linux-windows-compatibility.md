# Linux and Windows via WSL2 Compatibility Plan

## Goal

Make bb explicitly support Linux and Windows via WSL2 for local development and
persistent-host runtime flows, with CI and test coverage that prevents regressions.
Use a small, documented set of cross-platform third-party packages where that
reduces maintenance versus homegrown OS-specific wrappers. Native Windows shell
support is deferred unless we choose to take it on later.

## Support Target

### In scope

- `pnpm install`
- `pnpm exec turbo run build`
- `pnpm exec turbo run typecheck`
- `pnpm exec turbo run test`
- app + server + host-daemon startup on Linux and inside WSL2
- local/persistent host flows for:
  - creating and updating local-path projects
  - unmanaged environments
  - managed clone/worktree environments
  - provider runtime startup (`codex`, `claude-code`, `pi`) where the provider
    itself is installed in the supported Linux or WSL2 environment

### Out of scope unless we choose otherwise during implementation

- native Windows PowerShell, CMD, and host-daemon runtime support
- native Windows path, shim, and launcher integration outside WSL2
- making E2B sandboxes themselves run on Windows
- preserving shell-script setup hooks as the only setup mechanism
- ad hoc Unix-only QA helpers that are not part of the supported product path

## Current Status

- Milestone 1 implementation is complete on this local branch:
  - Phase 1 decision record exists in [docs/platform-support.md](../docs/platform-support.md)
  - package/build portability, shared launch helpers, path validation, setup-hook
    migration, and Linux app/runtime support changes are in the repo
  - Linux text-input local-path creation/update is the supported cross-platform
    app fallback; native folder picking remains macOS-only
- Recent local validation is green:
  - `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/domain --filter=@bb/server-contract --filter=@bb/server`
  - `pnpm exec turbo run test --filter=@bb/app --filter=@bb/domain --filter=@bb/server-contract --filter=@bb/server`
- The workflow now includes:
  - Ubuntu CI for supported Linux product-path validation
  - Windows preflight (`install`, `build`, `typecheck`) as an optional
    early-warning signal for script portability, not as a native Windows support
    gate
  - Ubuntu lint/test
  - Ubuntu Linux smoke
- This branch is currently ahead of `origin` with local follow-up commits, so the
  Milestone 1 CI sign-off should be refreshed by pushing the branch and rerunning
  GitHub Actions before we formally close the milestone checklist.

## Remaining Gaps

### WSL2 support still needs an explicit product contract

- The plan still needs to define the supported WSL2 shape explicitly:
  - supported distro, with Ubuntu as the default target
  - all `bb` processes run inside WSL2 rather than split between Windows and WSL
  - provider CLIs are installed inside WSL2
  - local project paths use Linux-style absolute paths inside WSL2
- We should decide whether repositories under `/mnt/c/...` are unsupported or
  best-effort. The simplest support contract is to require repositories inside
  the WSL filesystem and defer Windows-mounted paths unless there is product
  demand.

### Native Windows runtime work is no longer part of the active rollout

- The branch still contains optional `windows-latest` preflight coverage, but
  native Windows launchers, `.cmd` shim handling, and Windows-specific provider
  startup are no longer release blockers.
- If we later want native Windows support, the deferred work is still the same:
  launcher contract, shim-aware process launching, Windows path behavior, and
  native host-daemon UX.

### Root scripts and maintainer tooling still have cleanup opportunities

- Several root scripts still import built artifacts like
  `packages/config/dist/defaults.js`, which keeps a build-order dependency in
  repo-level tooling such as
  [scripts/run-bb-dev.mjs](../scripts/run-bb-dev.mjs),
  [scripts/run-host-daemon.mjs](../scripts/run-host-daemon.mjs),
  [scripts/reset-bb-data.mjs](../scripts/reset-bb-data.mjs), and
  [scripts/start-host-daemon.mjs](../scripts/start-host-daemon.mjs).
- Some maintainer/dev scripts still use Unix-oriented signal handling, including
  [scripts/run-host-daemon.mjs](../scripts/run-host-daemon.mjs),
  [scripts/start-bb.mjs](../scripts/start-bb.mjs), and
  [scripts/lib/run-dev-supervisor.mjs](../scripts/lib/run-dev-supervisor.mjs).

### Process management and test harnesses are Unix-heavy

- Dev restart uses `SIGUSR1` in
  [scripts/request-dev-restart.mjs](../scripts/request-dev-restart.mjs).
- Integration cleanup depends on `lsof` and `SIGKILL` in
  [tests/integration/global-setup.ts](../tests/integration/global-setup.ts).

### CI only partially protects the new support contract

- CI now covers Ubuntu + optional Windows preflight and Ubuntu smoke in
  [.github/workflows/ci.yml](../.github/workflows/ci.yml).
- CI does not currently validate WSL2 directly, so Milestone 2 still needs a
  small manual WSL2 sign-off path and clearer support docs.

## Plan

This rollout is split into two milestones. Milestone 1 is intentionally not
"Linux only"; it includes the shared compatibility foundation we need in order
to avoid redoing script, checkout, setup-hook, and path work later. Milestone 2
finishes the Windows story by standardizing on WSL2 instead of native Windows,
then locks the result in with final docs and validation.

### Milestone 1: Shared Foundation + Linux Support

Deliver a supported Linux product path for persistent-host flows while landing
the shared compatibility work that WSL2 support will depend on. Optional native
Windows preflight can stay green during this milestone, but native Windows
runtime support is not part of the contract.

#### Phase 1: Define the platform contract

1. Decide the official support matrix for the milestone boundary:
   - Linux persistent host: supported at Milestone 1 exit
   - Windows via WSL2 persistent host: supported at Milestone 2 exit
   - native Windows install/build/typecheck: optional preflight during Milestone 1
   - macOS persistent host: keep supported
   - E2B sandbox runtime: Linux-only unless explicitly expanded
2. Document which features are expected to work on each OS at each milestone.
3. Split supported product flows from Unix-only maintainer tooling so we do not
   block the rollout on QA helper scripts.
4. Decide the dependency policy for cross-platform maintenance:
   - prefer a small shared package set over many repo-local one-off scripts
   - keep packages at true boundaries: env injection, process launch, and OS
     open/folder-picker integration
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
  - the milestone-based OS support matrix
  - maintainer-only or best-effort exclusions
  - the chosen package set and rationale
  - the setup-hook end state and any temporary migration bridge
  - the line-ending policy and any optional native Windows checkout expectations
- Product documentation clearly distinguishes supported flows from maintainer
  tooling and best-effort surfaces

#### Phase 2: Make packaging, checkout, and critical security paths portable

1. Replace inline env assignments with a cross-platform mechanism:
   - `cross-env` for package scripts
   - small Node entrypoint scripts only when a script needs more than env
     injection
2. Replace `rm -rf`, `mkdir -p`, and `cp` in package scripts with:
   - `rimraf` for recursive cleanup
   - repo-local Node scripts for copy/create-directory logic
3. Standardize the script layer so the same package choices are reused across
   the repo instead of mixing multiple approaches package by package.
4. Fix the attachment containment bug before expanding runtime coverage:
   - replace string-prefix checks with `path.relative`-based containment
   - add targeted traversal tests for both POSIX and Windows-style paths
5. Define and implement repository line-ending policy:
   - add `.gitattributes` entries for supported text and script files
   - normalize any cross-platform parsing that currently assumes a checked-out
     script or fixture will always be LF-terminated
6. Remove assumptions that `pnpm`, `node`, or provider CLIs are launched through
   POSIX shell parsing.
7. Add an automated Ubuntu CI path for install/build/typecheck, plus optional
   `windows-latest` preflight when the extra signal is worth the cost.
8. Keep Turbo as the only supported task runner path.

**Validation**

- `pnpm install`
- `pnpm exec turbo run build --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli`
- `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/host-workspace --filter=@bb/agent-runtime --filter=@bb/db`
- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/app`
- Ubuntu CI is green for install, build, and typecheck
- If `windows-latest` preflight remains enabled, it stays green as a non-blocking
  portability signal
- Attachment reads reject traversal correctly on both POSIX and Windows-style
  paths

#### Phase 3: Deliver Linux product-path support on the new foundation

1. Introduce a shared child-process launch helper backed by `cross-spawn` for
   portability-sensitive launch paths.
2. Make Linux host-daemon and CLI launcher support use the new launch contract:
   - `bb` is available inside a thread runtime shell
   - runtime shell env uses `path.delimiter`
   - no shared logic relies on Unix executable-bit checks that Windows will
     later need to bypass
3. Implement the setup-hook end state for supported Linux flows:
   - provisioning prefers `.bb-env-setup.ts`
   - any `.bb-env-setup.sh` bridge stays POSIX-only and explicitly temporary
4. Complete Linux local project UX:
   - add Linux folder picking if practical
   - otherwise expose an app-side validated absolute-path text input
   - keep `open-path` working with graceful error handling
5. Fix any remaining path/UI issues required for Linux local project flows.
6. Add Linux smoke coverage and keep optional Windows preflight green if we
   continue to run it.

**Validation**

- `pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/agent-runtime --filter=@bb/host-workspace --filter=@bb/app --filter=@bb/server`
- `pnpm exec turbo run test:smoke --filter=@bb/integration-tests`
- CI:
  - Linux smoke is green on `ubuntu-latest`
  - Optional Windows preflight remains green during Milestone 1 if retained
- When a dedicated Linux desktop host or VM is not available, treat the
  GitHub-hosted Ubuntu smoke job as the Milestone 1 Linux sign-off path.
- Recommended manual verification when a Linux desktop host or VM is available:
  - start host daemon on Linux
  - confirm provider startup succeeds for at least one installed provider on
    Linux
  - confirm `bb` is available inside a thread runtime shell on Linux
  - provision managed clone/worktree on Linux
  - create a local-path project from the app on Linux
  - update an existing local-path source from the app on Linux
  - confirm Linux smoke coverage is green and Windows preflight remains green

**Milestone 1 Exit Criteria**

- [x] A Phase 1 decision record documents the milestone-based OS support matrix,
      minimal dependency set, setup-hook policy, and Windows line-ending
      expectations
- [ ] `pnpm install`, `pnpm exec turbo run build`, `pnpm exec turbo run typecheck`,
      and `pnpm exec turbo run test` succeed in Linux CI for the supported
      product path
      Note: rerun GitHub Actions after pushing the latest local branch commits.
- [ ] If retained, native Windows preflight CI is green for install, build, and
      typecheck as a non-blocking portability signal
      Note: rerun GitHub Actions after pushing the latest local branch commits.
- [x] Cross-platform maintenance uses a documented, minimal dependency set
      instead of package-by-package custom shell fixes
- [x] Attachment containment is fixed and tested for both POSIX and Windows-style
      paths
- [x] The repo enforces a line-ending policy that keeps supported flows working
      on default Windows Git checkouts
- [x] Host daemon starts successfully on Linux for persistent-host flows
- [x] Provider runtime startup works on Linux for at least one installed
      provider, and the launch path already uses the shared launch helper
- [x] Managed environment setup no longer depends on `/bin/bash` for supported
      Linux flows
- [x] App-based local project creation/update works on Linux through native
      folder picking or the supported text-input fallback
- [x] Linux sign-off is automated in GitHub-hosted Ubuntu CI when a dedicated
      Linux desktop host is not available, with manual desktop verification kept
      as a recommended follow-up rather than a Milestone 1 blocker

### Milestone 2: WSL2 Support + Final Hardening

Finish the Windows support story by standardizing on Ubuntu on WSL2 rather than
native Windows, then lock the result in with final docs, a WSL-specific
validation checklist, and any remaining tooling cleanup that affects the
supported product path.

#### Phase 4: Define and validate the WSL2 support contract

1. Document the supported Windows shape explicitly:
   - Windows support means Ubuntu on WSL2
   - all `bb` processes run inside WSL2
   - provider CLIs are installed inside the same WSL2 distro
   - native Windows PowerShell and CMD execution are unsupported
2. Decide and document repository location policy:
   - preferred and supported: repositories live inside the WSL filesystem
   - `/mnt/c/...` and other Windows-mounted paths are either explicitly
     unsupported or clearly marked best-effort
3. Validate the supported WSL2 runtime path:
   - host daemon starts inside WSL2
   - `bb` is available inside a thread runtime shell in WSL2
   - provider startup succeeds for at least one installed provider inside WSL2
4. Validate the supported WSL2 workspace path:
   - managed clone/worktree provisioning works inside WSL2
   - app local-path creation/update works with Linux-style absolute paths from
     the WSL environment
5. Capture any WSL-specific prerequisites or limitations that fall out of that
   validation in the support docs.

**Validation**

- `pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/agent-runtime --filter=@bb/host-workspace --filter=@bb/app --filter=@bb/server`
- Manual:
  - start host daemon inside WSL2
  - confirm provider startup succeeds for at least one installed provider inside
    WSL2
  - confirm `bb` is available inside a thread runtime shell inside WSL2
  - provision managed clone/worktree inside WSL2
  - create and update a local-path project from the app using WSL-style absolute
    paths

#### Phase 5: Final hardening, CI, and docs

1. Replace or isolate Unix-only test cleanup code (`lsof`, signal assumptions).
2. Replace dev-supervisor restart signaling with a cross-platform control path:
   - PID file + local control socket/HTTP endpoint, or
   - file-based restart requests
3. Move Unix-specific QA helpers behind explicit Linux/macOS-only tooling if they
   are not part of the supported product path.
4. Keep Ubuntu as the primary CI support gate and decide whether optional native
   Windows preflight is worth keeping for early warning on script portability.
5. Expand the earlier install/build/typecheck preflight into a support matrix
   that matches the actual contract:
   - `ubuntu-latest`
    - `macos-latest` for host-local API coverage if cost is acceptable
6. Split jobs so failures are attributable:
   - install/build/typecheck
   - unit tests
   - smoke tests for server + host-daemon startup
7. Add a small smoke suite that verifies:
   - server starts
   - host daemon starts
   - local API health responds
   - unmanaged environment path works
   - local-path project creation path works
8. Update README with supported OSes and any intentional WSL-only or Linux-only
   surfaces.
9. Document required host prerequisites per environment:
   - Git
   - Node / pnpm
   - provider CLI installation expectations
   - WSL2 and Ubuntu setup expectations for Windows users
10. Document known limitations that remain after rollout.

**Validation**

- `pnpm exec turbo run test --filter=@bb/integration-tests`
- CI matrix is green on all supported environments for:
  - install
  - build
  - typecheck
  - tests
  - smoke
- Docs include:
  - supported OS matrix, including Windows via WSL2
  - startup instructions for Linux, macOS, and WSL2
  - any explicitly unsupported flows

**Milestone 2 Exit Criteria**

- [ ] Windows support is documented as Ubuntu on WSL2, with all `bb` processes
      and provider CLIs running inside WSL2
- [ ] Host daemon starts successfully on Linux, macOS, and WSL2 for
      persistent-host flows
- [ ] Provider runtime startup works on Linux and WSL2 for at least one
      installed provider, and the launch path stays within the shared Linux/WSL
      contract
- [ ] Managed environment setup no longer depends on `/bin/bash` for supported
      flows, and WSL repository-location expectations are clearly documented
- [ ] App-based local project creation/update works on Linux and WSL2 through
      native folder picking or the supported text-input fallback
- [ ] CI includes the supported Linux/macOS coverage for build, typecheck,
      tests, and smoke startup, with optional native Windows preflight only if
      we still want the extra signal
- [ ] README documents the supported OS matrix, WSL2 setup expectations, and
      any intentional exceptions

## Risks and Decisions

### Setup hook migration

The supported end state is `.bb-env-setup.ts`. If a migration bridge is needed
for existing repositories, keep `.bb-env-setup.sh` Unix-only, explicitly
temporary, and out of the final WSL2 support contract and exit criteria.

### Provider availability in WSL2

bb can only support providers that themselves support Linux inside WSL2. We
should define product behavior when a provider is unavailable in the supported
host environment:

- hide it from recommendations where possible
- return a clear host-local error when selected anyway

### Linux-only sandbox surfaces

If sandbox execution remains Linux-only, that should be a documented product
decision, not an accidental implication of the implementation.

### WSL repository location and path behavior

The simplest supported contract is to keep repositories inside the WSL
filesystem:

- `.gitattributes` must enforce predictable line endings for supported source
  files and scripts
- local project paths should be Linux-style absolute paths inside WSL2
- if `/mnt/c/...` paths remain unsupported, the docs should say that explicitly
- if `/mnt/c/...` paths are allowed as best-effort, the docs should warn about
  the lack of full support guarantees

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

1. Milestone 1 / Phase 1
2. Milestone 1 / Phase 2
3. Milestone 1 / Phase 3
4. Milestone 2 / Phase 4
5. Milestone 2 / Phase 5

This order lands the shared compatibility and security foundations first,
delivers a real Linux support milestone second, and only then finishes the WSL2
support contract and final hardening.
