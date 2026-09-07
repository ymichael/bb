# Scheduled messages

Status: **2026-09-05: 2 passed, 3 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Use + → Send later from root and follow-up composers; core thread queue supplies agent access.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/scheduled-send/package.json`
- `plugins/scheduled-send/server.ts`
- `plugins/scheduled-send/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Presets and custom time | Choose each offered preset, enter a custom local time, and schedule a harmless prompt. | Displayed time/countdown represents intended timezone and future dispatch time. |
| Draft capture | Schedule a draft with file/image attachments, mentions and execution options, then change the current composer. | The scheduled payload retains its own captured content/options and does not borrow later draft edits. |
| Dispatch | Wait for a near-future root message and thread follow-up to fire. | Exactly one intended thread/turn receives each message at the eligible time. |
| Send now and delete | Use countdown actions to send one immediately and delete another. | Queue/UI agree; deleted payload never dispatches and send-now does not leave a second scheduled send. |
| Eligibility and bounds | Try empty/in-flight drafts, past times and times beyond the one-year bound. | Controls and validation reject unsupported input without creating a hidden queued message. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- For headless Chromium, first inspect matchMedia("(hover: hover)"). When false, focus the row using its Reorder button, then Tab to Send now/Edit/Delete and press Enter. Pointer-only clicks on hidden actions can silently miss. Verify queue state via CLI/API, then refresh the UI if its snapshot lags. Source: `apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx:877`.
