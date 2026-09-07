# Agent interfaces, route compatibility, and error contracts

Status: **2026-09-05: 3 passed, 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Isolated source server, source CLI, and SDK from this checkout. Use real IDs from targeted list/show calls.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `packages/server-contract/src/public-api.ts`
- `packages/client-core/src/routes/route-paths.ts`
- `apps/cli/src/commands/manager.ts`
- `apps/cli/src/commands/status.ts`
- `apps/cli/src/commands/guide.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| CLI context and routing | Run status inside and outside a thread with explicit project/environment selectors; compare returned target with the server. | Commands act on the stated context; missing/ambiguous IDs fail instead of guessing another project. |
| SDK parity | For each mapped CLI/UI operation, find its call in the command source and use the same sdk area with schema-valid input in an isolated harness. | SDK mutation/read observes the same persisted product state; undocumented agent gaps are recorded, not invented. |
| Pagination and version conflicts | Page thread/history/file lists with bounded requests; update revisioned data from two clients. | No missing/duplicate records at page boundaries; stale writes conflict without data loss. |
| Invalid IDs and malformed input | Send invalid IDs, schema-invalid values, missing required parameters, and unsupported enum variants through CLI/API. | Errors identify the boundary and cause; no partial unintended mutation occurs. |
| Legacy routes | Open /tools, /skills, old automation/detail routes, project compose aliases, and projectless thread links from route-paths. | Redirects resolve to current screens with valid IDs preserved; aliases are not documented as separate new features. |
| Removed manager commands | Run bb manager and its compatibility subcommands on isolated CLI. | Nonzero exit explains that parent threads replace managers; no obsolete manager is created. |
| Guide and help | Use bb guide and nested --help for each command family and plugin command. | Discoverable descriptions, flags, and examples match runtime behavior. Do not treat a help listing as a live feature test. |
| Authentication callback and reconnect | Exercise auth callback with a disposable server session and an invalid/expired response; reload a disconnected client. | Session setup is scoped to the right origin and failure is visible; credentials never enter evidence. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- `status` accepts --json, not --project/--environment flags. To verify in-thread context after the source env helper clears inherited context, set BB_PROJECT_ID/BB_THREAD_ID/BB_ENVIRONMENT_ID to resolved synthetic IDs before the source CLI invocation; keep BB_CLI/BB_CLI_REEXEC unset. Source: `apps/cli/src/commands/status.ts:50`.
- Open Settings → Remote access (plugin id `connect`). Use `bb connect` for command help; this parser rejects `bb connect --help` as an unknown flag. Use `off` to disconnect and forget credentials, or the plugin enable toggle to suspend the tunnel while retaining pairing. Source: `plugins/connect/src/cli.ts:74`.
- Verify callback presentation with `/auth/callback?status=error` and success/default. This view does not redeem a code or create a session; exercise actual authentication in its owning provider flow. `?error=` or an arbitrary `?code=` does not select the failure view. Source: `apps/app/src/views/AuthCallbackView.tsx:15`.
