# Machines, daemon lifecycle, and updates

Status: **2026-09-05: 2 passed, 6 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

A separate disposable host/daemon for enrollment, permission, disconnect, and update tests. Never revoke or update the host carrying this agent session.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/app/src/views/MachineSettingsView.tsx`
- `apps/cli/src/commands/machine.ts`
- `apps/cli/src/commands/updates.ts`
- `apps/host-daemon/src/server-connection.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| List, inspect, rename | Compare Machines with machine list/show; rename a disposable host and reload. | Stable host ID is preserved; name and connection state agree. |
| Pair and enroll | Create machine join-code and redeem on the disposable host; attempt expired/reused code. | Exactly one intended host enrolls; invalid or consumed codes do not enroll another. |
| Permission ceiling | Change the disposable machine ceiling and request a more permissive thread. | Host ceiling is enforced across UI, CLI, and runtime rather than merely hidden in the picker. |
| Disconnect and reconnect | Stop only the disposable daemon, observe unavailable host, restart it, and retry a targeted read. | Status and routing recover to the same host; offline operations do not route to a different machine. |
| Protocol mismatch and automatic update | Use the documented QA setup with a deliberately older disposable daemon; inspect rejected protocol and retry-update. | Mismatch initiates the expected update or actionable failure; incompatible payloads are not accepted in a reconnect loop. |
| Provider CLI installation | Inspect machine provider-cli status; install/update a chosen provider on the disposable host. | Version and health refresh on that host; failure does not claim installation. |
| Updates status and apply | Compare updates status and Settings → Updates; apply only available fixture-host updates. | Per-host/per-provider outcomes are reported; absent updates produce a truthful no-op. |
| Remove host | Revoke the disposable host with machine remove; try reconnecting it with its old enrollment. | Revoked host cannot reconnect; unrelated hosts and projects are unaffected. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- Use UI machine ceiling and compare requested CLI execution with persisted runtime mode. SDK hosts.update is name-only; record the missing public ceiling setter as an agent-parity gap. Source: `apps/cli/src/commands/machine.ts; apps/app/src/views/MachineSettingsView.tsx; apps/app/src/hooks/mutations/host-mutations.ts:61; packages/sdk/src/areas/hosts.ts`.
