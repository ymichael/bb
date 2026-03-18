# Goal

Rename the main bb runtime from "daemon" to "server" everywhere, while keeping
`env-daemon` unchanged.

This is a hard cutover, not a soft alias migration. After this change, the main
process, its commands, scripts, docs, UI, and internal symbols should all use
"server" consistently. `env-daemon` remains the name for the environment-side
session supervisor layer.

# Scope

In scope:

- CLI command names and help text
- root package scripts and user-facing commands
- UI labels, toasts, tooltips, and status text
- frontend hooks, utilities, API helpers, and filenames that refer to the main
  runtime as "daemon"
- server-side route names, API types, helper names, and filenames that refer to
  the main runtime as "daemon"
- docs, QA docs, scripts, architecture docs, and plans that refer to the main
  runtime as "daemon"
- tests and snapshots that assert the old terminology

Out of scope:

- `env-daemon` naming and package names
- session protocol names like `/env-daemon/...`
- environment-daemon internal concepts that are specifically about the
  environment-side daemon

# Implementation Steps

1. Define the vocabulary boundary clearly.

- `server` means the main bb process (`@bb/server`)
- `env-daemon` means the environment-side session/runtime layer
- docs and code should not use "daemon" as a generic synonym for the main
  process after the cutover

2. Rename the user-facing command surface.

- Change `bb daemon ...` to `bb server ...`
- Change root `pnpm daemon` to `pnpm server`
- Update README examples, setup docs, QA docs, and help text accordingly
- Update any test fixtures or snapshots that assert the old command names

3. Rename user-facing UI and API language.

- Replace "daemon" with "server" in sidebar labels, tooltips, toasts, and
  status strings
- Rename user-facing API helpers and hooks such as `restartDaemon`,
  `shutdownDaemon`, `useRestartDaemon`, `useDaemonConnectionState`, and
  `daemon-status-indicator` to `restartServer`, `shutdownServer`,
  `useRestartServer`, `useServerConnectionState`, and `server-status-indicator`
- Rename route/docs wording like "daemon status" and "daemon restart" to
  "server status" and "server restart"

4. Rename internal code symbols and files for the main runtime.

- Rename variables, functions, types, filenames, and tests that refer to the
  main runtime as "daemon"
- Examples likely include names such as `daemonBaseUrl`, `daemonLogFilePath`,
  `resolveDaemonUrl`, `BB_DAEMON_URL`-related helpers, `standalone-daemon-*`
  test files, and QA script names
- Keep env-daemon-specific names intact

5. Decide what happens to `BB_DAEMON_URL`.

- This is the main unavoidable compatibility decision
- For a hard cutover, rename it to `BB_SERVER_URL`
- If we do that, update:
  - CLI env resolution
  - provider environment injection
  - environment-agent config
  - docs and `.env.example`
  - tests and QA scripts
- Because this is prelaunch, prefer one name over carrying both

6. Rename docs and scripts aggressively.

- Update README, ARCHITECTURE, QA docs, AGENTS.md guidance, and plan docs
- Rename script files like `start-standalone-daemon-qa.mjs` if they refer to
  the main runtime
- Rename test files and scenario names like `standalone-daemon-*` when they
  refer to the main runtime rather than env-daemon

7. Run a full terminology sweep.

- Search for `daemon`, `Daemon`, and `daemon-`
- Review every remaining match and classify it as either:
  - must become `server`
  - should remain `env-daemon`
  - should remain because it is part of an external contract we intentionally
    keep

# Validation

- `rg` for `daemon` in the repo should leave only env-daemon references and
  intentional historical mentions
- CLI help should expose `bb server`, not `bb daemon`
- root scripts should expose `pnpm server`, not `pnpm daemon`
- README and QA docs should refer to the main runtime as "server"
- frontend text should say "server" everywhere the user sees it
- typecheck should pass for touched packages
- targeted tests should pass for:
  - CLI command registration/output
  - server restart/shutdown UI flows
  - QA helper scripts
  - any renamed route/helper tests

# Open Questions/Risks

- Should `BB_DAEMON_URL` be hard-renamed to `BB_SERVER_URL` now, or is that too
  much churn for one pass?
- Do we want to rename filesystem artifacts like `daemon.log` as part of the
  same cutover?
- How aggressive should we be with test/scenario filenames versus just symbols
  and user-facing text?
- Some docs and QA materials discuss "daemon" historically or conceptually; we
  should avoid accidentally renaming env-daemon references that are still
  correct.
