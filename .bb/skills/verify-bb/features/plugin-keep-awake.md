# Keep machines awake

Status: **2026-09-05: 4 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Settings → Plugins → Keep awake; bb keep-awake --help. A disposable macOS host is required for an actual power assertion; Linux can verify unsupported-host reporting.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/keep-awake/package.json`
- `plugins/keep-awake/server.ts`
- `plugins/keep-awake/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Global and host selection | Enable globally, select one test host, and inspect status/hosts. | Effective host selection matches stored preferences and actual host capability. |
| Assertion lifetime | Enable on macOS, inspect the OS assertion, then disable and stop the test daemon. | Expected sleep-prevention assertion exists only while enabled; it is released on shutdown. |
| Reconnect | Reconnect the selected test host while the preference remains enabled. | The assertion is reapplied once and status recovers. |
| Unsupported platform | Enable against a Linux fixture and inspect status. | Unsupported behavior is explicit; no claim is made about keeping the display on or preventing lid sleep. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Enable against a Linux fixture, inspect configuration with keep-awake status, and inspect plugin logs for the unsupported-host warning. The status command returns desired configuration, not per-host support or effective assertion state. Source: `plugins/keep-awake/server.ts:150 and :249`.
- On Linux, enable the preference, inspect the macOS-only UI explanation and `plugin logs keep-awake` warning, then restore it. `keep-awake status` reports configuration, not host capability or an effective OS assertion. Source: `plugins/keep-awake/server.ts:248`.
