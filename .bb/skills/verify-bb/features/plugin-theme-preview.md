# Theme preview workbench

Status: **2026-09-05: 3 passed, 1 failed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Open Theme preview in a development/test app with a disposable custom theme file.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/theme-preview/package.json`
- `plugins/theme-preview/server.ts`
- `plugins/theme-preview/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Catalog and activation | Browse the theme catalog, select a theme, and change light/dark mode. | Workbench and actual app use the selected palette and mode consistently. |
| Representative scenes | Visit mock conversation, split panes, settings, overlays and component examples. | Text, borders, focus, selection and layered surfaces follow theme tokens in every scene. |
| Custom theme refresh | Edit the fixture theme file and trigger/watch refresh. | Updated values render without switching to a stale catalog entry; invalid files produce clear feedback. |
| Contrast inspection | Use the offered contrast/style-sheet views and inspect representative token pairings. | Reported colors/pairings correspond to actual rendered tokens; inspection does not silently rewrite a theme. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Wait for the catalog and computed token measurements before asserting values; initial chips can say Loading themes and contrast can show an em dash.
- Isolate malformed or oversized CSS checks from other workers. At the audited revision, Theme Preview reads catalog CSS without the core 256,000-character bound and its block-matching regex takes quadratic time on a long brace-free input. A 256,001-space fixture stalled the shared server for roughly 38 seconds; removing only that fixture restored responsiveness. Preserve expected bounded, responsive handling as a product requirement. Source: `plugins/theme-preview/server.ts:99`, `plugins/theme-preview/server.ts:148`, `plugins/theme-preview/server.ts:340`.
