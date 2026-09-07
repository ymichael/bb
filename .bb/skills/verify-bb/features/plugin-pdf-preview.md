# PDF preview

Status: **2026-09-05: 2 passed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Open a synthetic multi-page PDF via the PDF file opener on browser and relevant native client.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/pdf-preview/package.json`
- `plugins/pdf-preview/server.ts`
- `plugins/pdf-preview/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Source selection | Open a workspace PDF, host file PDF, and thread-storage attachment. | Viewer fetches the selected source and correct PDF bytes/MIME. |
| Navigation | Use available browser-native page navigation, zoom, search, and download controls. | Controls affect the selected document; unsupported native-viewer controls are recorded per client. |
| Loading and retry | Open a missing PDF or disconnect its fixture host, then restore and retry. | Loading/error/retry states are visible and recovery displays the same requested document. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
