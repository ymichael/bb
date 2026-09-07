# Plugin API tester

Status: **2026-09-05: 2 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Development build with this dev-only plugin enabled; release builds default it off.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/plugin-api-tester/package.json`
- `plugins/plugin-api-tester/server.ts`
- `plugins/plugin-api-tester/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Placeholder panel | Open its navigation entry and reload its panel route. | Development placeholder renders and preserves valid route handling. |
| Lifecycle | Disable/re-enable the plugin and inspect contributed surfaces. | Panel entry tracks lifecycle; no nonexistent CLI/tools/settings are claimed for the placeholder. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
