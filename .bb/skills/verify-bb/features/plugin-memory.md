# Persistent agent memory

Status: **2026-09-05: 6 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Settings → Memory; bb memory --help. Use uniquely prefixed synthetic records at global and disposable-project scope.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/memory/package.json`
- `plugins/memory/server.ts`
- `plugins/memory/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Create and edit | Add records with supported kind, tags, importance, provenance, and project/global scope; edit one. | Saved structured values survive reload and stay in the chosen scope. |
| Search, get, catalog | Search exact and partial terms with scope filters; fetch a record and bounded catalog. | Results and summaries reference correct IDs and scopes; unrelated records are not returned as matches. |
| Pinning and instruction budget | Pin/unpin fixtures and start a new task with enough records to exercise the summary budget. | Instruction index respects the configured budget and prioritization; full records remain retrievable rather than silently included in full. |
| History and revision conflicts | Read versions, update from two clients with the same revision, then inspect history. | One stale write conflicts; accepted changes retain provenance and prior versions. |
| Delete | Delete only prefixed fixtures through CLI and settings. | Deleted records disappear from new task indices and queries without affecting other scopes. |
| Rejected content | Submit synthetic obvious secret-like and instruction-injection examples from existing tests, never real credentials. | Boundary validation follows the implemented rejection rules and leaves no rejected record stored. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- The instruction catalog has a fixed 3,900-character budget, including header/footer; it is not a user-configurable budget. Add enough long synthetic summaries and verify the Showing X of Y footer plus full-record retrieval. Source: `plugins/memory/server.ts:9; plugins/memory/server.ts:775`.
