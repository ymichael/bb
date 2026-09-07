# Remote Connect and port sharing

Status: **2026-09-05: 5 passed, 2 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Settings → Remote access; use `bb connect` for command help. Use the local cloud stack and a fresh synthetic store/account. Never pair an imported store or use the owner’s live tunnel as a fixture.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/connect/package.json`
- `plugins/connect/src/server.ts`
- `plugins/connect/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Account pairing | Create a dashboard pairing code, redeem it on the disposable server, then try expired/reused codes. | Only the intended test server pairs; invalid codes cannot claim another account or tunnel. |
| Remote app and status | Open the returned test tunnel URL, inspect connect status, and perform a read-only project lookup. | Remote browser and CLI address the same synthetic server and authenticated account. |
| Reconnect | Interrupt only the test tunnel, observe disconnected status, and restore its connection. | The same authorized test server recovers; stale credentials cannot take ownership. |
| Port shares | Start a harmless HTTP fixture, expose its port, inspect shares, request the returned URL, then unexpose it. | Shared response is the fixture’s; removal makes that share unavailable without stopping unrelated shares. |
| Mobile machine code and QR | With the mobile experiment enabled, pair a test phone/profile using the supported QR and machine-code flow. | Correct machine label/origin is stored; consumed/revoked codes fail. |
| Disable and forget | Turn Connect off for the test store, re-enable it, then forget its pairing. | Disabling closes the tunnel; forgetting removes test authorization and requires a fresh pairing. |
| Authentication isolation | Open a test tunnel as another synthetic account and test revoked sessions. | Unauthorized requests cannot access another account’s machine; evidence excludes session credentials. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Open Settings → Remote access (plugin id `connect`). Use `bb connect` for command help; this parser rejects `bb connect --help` as an unknown flag. Use `off` to disconnect and forget credentials, or the plugin enable toggle to suspend the tunnel while retaining pairing. Source: `plugins/connect/src/cli.ts:74`.
