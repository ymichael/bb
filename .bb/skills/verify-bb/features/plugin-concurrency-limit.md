# Agent concurrency limits

Status: **2026-09-05: 4 passed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Settings → Plugins → Concurrency limit; disposable threads with short controllable turns on one or two test hosts.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/concurrency-limit/package.json`
- `plugins/concurrency-limit/server.ts`
- `plugins/concurrency-limit/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Automatic, global, and per-host limits | Inspect automatic values, set a small global cap and a host override, then restore defaults. | Effective limit follows the configured global/host policy and processor-derived automatic value. |
| Queued admission | Start more idle-thread turns than the cap permits; finish one admitted turn. | Excess starts wait; the next eligible turn begins when capacity is released. |
| Steering an active turn | Steer an already active thread while the cap is full. | Existing active work accepts steering without requiring a second concurrency slot. |
| Release and recovery | Finish, error, stop, and archive synthetic active threads; reconnect a host. | Admission is rechecked without leaked slots or duplicate starts. |
| Configuration bounds | Try supported unlimited/numeric settings and out-of-range values using the plugin schema. | Accepted values persist; invalid values fail without changing the effective limit. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Use Settings → Concurrency limit. The global UI control is labeled Overall thread limit. Global unlimited is null; host auto uses availableParallelism. The per-host effectiveLimit field remains the host cap while globalLimit is enforced separately. Source: `plugins/concurrency-limit/app.tsx:1`.
