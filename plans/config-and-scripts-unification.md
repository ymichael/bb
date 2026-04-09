# Config And Scripts Unification

## Problem

The current root-entrypoint story mixes three different layers:

- `@bb/config` holds most validated runtime config
- `scripts/lib/runtime-config.mjs` duplicates a subset of those defaults for
  root scripts
- root `package.json` scripts still encode entrypoint policy directly

That creates an inconsistent mental model:

- server and host-daemon select dev/prod defaults through `NODE_ENV`
- CLI currently does not
- reusable orchestration code lives under repo-root `scripts/` instead of a
  real workspace package
- root commands sometimes bypass Turbo dependency ownership and import package
  code directly

The result is a half-bootstrap, half-package architecture that is harder to
reason about than either of the clean alternatives.

## Goal

Adopt one explicit model for all supported entrypoints:

- dev/prod defaults live in `@bb/config`
- `NODE_ENV` selects those defaults for server, host-daemon, CLI, and tooling
- reusable root-entrypoint logic lives in a real workspace package
- root `package.json` commands delegate to that package through Turbo
- repo-root `scripts/` stops being a shadow package for product-path entrypoints

## Design Decisions

### 1. `@bb/config` is the only source of defaults

`@bb/config` owns:

- raw defaults
- mode-aware default resolution
- validated runtime config for built entrypoints
- bootstrap-safe helpers needed by tooling

No product-path default values remain under `scripts/`.

### 2. `NODE_ENV` selects defaults, explicit `BB_*` values select concrete targets

The intended mode model becomes:

- `NODE_ENV=production` -> production defaults
- `NODE_ENV=development` -> development defaults

This applies to:

- server
- host-daemon
- CLI
- scripts/tooling package

Wrappers set `NODE_ENV` explicitly instead of relying on ambient shell state.

The precedence model is:

1. Explicit `BB_*` values such as `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, and
   `BB_DATA_DIR`
2. Otherwise, defaults selected by `NODE_ENV`

Examples:

- `pnpm start` should force `NODE_ENV=production`, but still respect an
  explicit `BB_DATA_DIR`
- `pnpm bb:dev` should force `NODE_ENV=development`, but still respect an
  explicit `BB_SERVER_URL`
- when the daemon injects `bb` into an agent runtime, it must pass explicit
  `BB_SERVER_URL` and `BB_HOST_DAEMON_PORT` for that exact runtime instead of
  relying on mode defaults

`NODE_ENV` is therefore a default-selection convenience, not an addressing
mechanism. Process-to-process handoff must pass concrete `BB_*` values for the
target instance.

### 3. Reusable script logic moves into `@bb/scripts`

Create a real workspace package, `packages/scripts` (`@bb/scripts`), that owns:

- start / stop orchestration
- dev host-daemon launcher
- CLI source wrappers
- reset commands
- restart helpers used by the dev loop
- shared script utilities currently under `scripts/lib/`

Repo-root `scripts/` should only contain code that is intentionally outside the
product-path entrypoint contract, such as ad hoc QA helpers. Everything else
either moves into `@bb/scripts` or is deleted.

### 4. Root commands delegate through Turbo

Root `package.json` should become thin wrappers such as:

- `pnpm start` -> `cross-env NODE_ENV=production dotenv -c production -- pnpm exec turbo run start --filter=@bb/scripts`
- `pnpm start:host-daemon` -> `cross-env NODE_ENV=production pnpm exec turbo run start:host-daemon --filter=@bb/scripts`
- `pnpm reset` -> `cross-env NODE_ENV=production pnpm exec turbo run reset --filter=@bb/scripts`
- `pnpm reset:dev` -> `cross-env NODE_ENV=development pnpm exec turbo run reset --filter=@bb/scripts`
- `pnpm bb` -> `cross-env NODE_ENV=production pnpm exec turbo run cli --filter=@bb/scripts --`
- `pnpm bb:dev` -> `cross-env NODE_ENV=development pnpm exec turbo run cli --filter=@bb/scripts --`

The root package keeps friendly command names, but ownership and dependency
ordering move into the workspace graph.

## Scope

### In scope

- creating `@bb/scripts`
- moving product-path root scripts and shared helpers into that package
- moving `runtime-config.mjs` behavior into `@bb/config`
- making CLI config use the same mode model as server and host-daemon
- updating root wrappers, docs, tests, and Turbo config
- deleting dead root-script compatibility shims that become unnecessary

### Out of scope

- `scripts/qa/*` migration
- redesigning the dev supervisor itself beyond packaging/ownership changes
- WSL2 manual validation already tracked in
  [`plans/wsl2-manual-validation.md`](./wsl2-manual-validation.md)

## Implementation Plan

### Phase 1: Move bootstrap-safe config helpers into `@bb/config`

1. Add a bootstrap-safe export to `@bb/config` for mode-aware default
   resolution. This should replace the current role of
   `scripts/lib/runtime-config.mjs`.
2. Keep the raw defaults in `@bb/config` and make the helper functions consume
   those defaults instead of duplicating them.
3. Update `@bb/config/cli` to use the same `NODE_ENV`-based default selection
   model as server and host-daemon.
4. Update `@bb/config` tests to cover the precedence model explicitly:
   explicit `BB_*` overrides win, otherwise `NODE_ENV` selects defaults.

Validation:

- `pnpm exec turbo run build --filter=@bb/config`
- `pnpm exec turbo run typecheck --filter=@bb/config`
- `pnpm exec turbo run test --filter=@bb/config`

### Phase 2: Create `@bb/scripts` and move product-path entrypoints into it

1. Create `packages/scripts` with build, typecheck, and test tasks.
2. Move the current product-path root entrypoints into `@bb/scripts` source:
   - `start-bb`
   - `start-host-daemon`
   - `run-host-daemon`
   - `run-bb-dev`
   - `reset-bb-data`
   - `request-dev-restart`
3. Move the shared utilities under `scripts/lib/` that are part of those
   entrypoints into `@bb/scripts`.
4. For each migrated script, capture the current behavior first and add a
   before/after verification target:
   - existing tests that already cover the script should be repointed to the new
     package module
   - missing coverage should be added before deleting the old path
   - CLI-style scripts should at minimum preserve `--help`, env override
     behavior, and argument forwarding
5. Replace direct imports from repo-root `scripts/lib/*` with package-local
   imports inside `@bb/scripts`.
6. Add tests around the package-level entrypoint helpers where behavior is
   non-trivial.

Validation:

- `pnpm exec turbo run build --filter=@bb/scripts`
- `pnpm exec turbo run typecheck --filter=@bb/scripts`
- `pnpm exec turbo run test --filter=@bb/scripts`
- manual before/after spot checks for each migrated root command before the old
  script path is deleted

### Phase 3: Rewire root wrappers to Turbo-owned package tasks

1. Add package scripts in `@bb/scripts` for the supported root commands:
   - `start`
   - `start:host-daemon`
   - `reset`
   - `cli`
   - `dev:host-daemon`
   - dev restart tasks as needed
2. Update root `package.json` so the public commands delegate to those package
   tasks through Turbo.
3. Ensure the root wrappers set `NODE_ENV` explicitly for prod vs dev modes
   instead of relying on ambient shell state.
4. Ensure wrappers force the intended mode while still honoring explicit
   `BB_*` overrides provided by the caller.
5. Remove product-path root `node scripts/...` execution from the root package
   scripts.

Validation:

- `pnpm install --frozen-lockfile`
- `pnpm start -- --help` if applicable, or run the package task directly
- `pnpm bb --help`
- `pnpm bb:dev --help`
- `pnpm start:host-daemon -- --help` if applicable

### Phase 4: Delete dead root-script code and update docs

1. Delete `scripts/lib/runtime-config.mjs`.
2. Delete or deprecate product-path root scripts that have been replaced by
   `@bb/scripts`.
3. Leave only explicitly out-of-scope helpers under repo-root `scripts/`
   (primarily `scripts/qa/*`, plus anything else intentionally kept outside the
   product path).
4. Update README and support docs so the command model is:
   - root commands are thin wrappers
   - `NODE_ENV` is the mode selector
   - explicit `BB_*` values override mode-selected defaults
   - process handoff uses explicit `BB_*` addressing
   - `@bb/config` owns defaults

Validation:

- `rg -n "scripts/lib/runtime-config|packages/config/dist" .`
- `rg -n "node scripts/" package.json README.md docs packages apps`
- `git diff --check`

### Phase 5: End-to-end verification

1. Run the affected package build/typecheck/test suites:
   - `pnpm exec turbo run build --filter=@bb/config --filter=@bb/scripts --filter=@bb/cli --filter=@bb/server --filter=@bb/host-daemon`
   - `pnpm exec turbo run typecheck --filter=@bb/config --filter=@bb/scripts --filter=@bb/cli --filter=@bb/server --filter=@bb/host-daemon`
   - `pnpm exec turbo run test --filter=@bb/config --filter=@bb/scripts --filter=@bb/app --filter=@bb/host-daemon`
2. Run manual smoke checks from the repo root:
   - `pnpm bb --help`
   - `pnpm bb:dev --help`
   - `pnpm start`
   - `pnpm dev:host-daemon` against a dev server when available
   - `BB_DATA_DIR=$(mktemp -d) pnpm reset -- --yes` or equivalent safe temp-dir
     reset validation
3. Re-run CI on the branch after the refactor lands.

## Exit Criteria

- [ ] `@bb/config` is the only source of dev/prod defaults
- [ ] The precedence rule is explicit and tested: `BB_*` overrides beat
      `NODE_ENV`-selected defaults
- [ ] CLI config follows the same `NODE_ENV` model as server and host-daemon
- [ ] `@bb/scripts` exists as a real workspace package with build/typecheck/test
- [ ] Every migrated script has explicit before/after verification coverage
- [ ] Root `package.json` entrypoints delegate through Turbo to `@bb/scripts`
- [ ] No supported product-path root command depends on repo-root
      `scripts/lib/runtime-config.mjs`
- [ ] Product-path root wrappers no longer execute `node scripts/...` directly
- [ ] Repo-root `scripts/` contains only intentionally out-of-scope helpers
- [ ] README and platform docs describe the new ownership and mode model

## Risks And Notes

- Turbo argument forwarding for CLI-style commands (`pnpm bb -- ...`) must be
  verified early. If it proves awkward, use a package-owned bin from
  `@bb/scripts`, but keep the ownership and config model unchanged.
- This refactor should not silently change QA-only or maintainer-only helpers.
  Keep those out of scope unless they block the new package layout.
- Do not preserve both the old root-script path and the new `@bb/scripts` path
  as parallel supported surfaces. The old path should be deleted once the new
  one is verified.

## Completion

Delete this plan once the refactor is complete or superseded.
