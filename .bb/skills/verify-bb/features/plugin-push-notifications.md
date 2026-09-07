# Web, desktop, and mobile notifications

Status: **2026-09-05: 1 passed, 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Notification settings plus platform OS permissions; use synthetic thread events and test device registrations.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/push-notifications/package.json`
- `plugins/push-notifications/server.ts`
- `plugins/push-notifications/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Permission and toggles | Allow/deny browser/OS permission and toggle web, desktop and mobile delivery independently. | Effective enabled state reflects both app preferences and platform permission. |
| Completion and interaction delivery | Generate a synthetic completed turn and a pending question while the app is backgrounded. | Correct thread notification and priority arrive on enabled clients; opening follows the intended thread. |
| Read and archival suppression | Read/archive/delete a target before delivery, then create another event. | Ineligible events are suppressed under the documented policy without suppressing unrelated unread events. |
| Deduplication | Open two same-origin tabs and multiple registered client types for one event. | Delivery follows client-type deduplication rules rather than notifying every tab independently. |
| Mobile closed-app delivery | With a registered test Expo device, close the app and generate an event, then tap it. | OS receives the push and opens the correct profile/thread; badge and read state reconcile. |
| Registration and diagnostics | List/add/remove only test registrations and invoke status/test. | Registration lifecycle is accurate; broadcast acknowledgement alone is never recorded as proof of OS delivery. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
