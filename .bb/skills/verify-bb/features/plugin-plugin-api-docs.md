# Plugin Guide

Status: **2026-09-05: 3 passed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Open Plugin Guide; source of surface inventory is packages/plugin-api-map/src/surfaces.ts. This is the in-app public API guide.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/plugin-api-docs/package.json`
- `plugins/plugin-api-docs/server.ts`
- `plugins/plugin-api-docs/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Guide maps | Visit app window, palette, composer, home, settings, plugin detail, and backend maps. | Each map renders its annotated fixture and matching numbered cards. |
| Cards and symbols | Select representative numbered cards, read their descriptions, follow internal links, and inspect SDK symbols through Copy for agent context. | Card, annotation and copied SDK context describe the same current API surface. |
| Navigation and agent context | Reload a map-group URL, use Copy for agent, and paste its rich Plugin Guide mention into a synthetic turn. | Selection survives routing; copied/resolved context identifies the correct surface and symbols. |
| Inventory reconciliation | Compare every surface in surfaces.ts with visible Guide cards, especially after a public SDK change. | No source surface lacks its documented map/card; use plugin-guide-maintenance for actual guide repairs. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Open representative numbered cards, read their capability descriptions, and follow internal surface links. Use Copy for agent and the resolved mention context to inspect relevant SDK symbols; do not expect a symbol or code-example section in the visible card. Source: `packages/plugin-api-map/src/surface-card.tsx:1`, `packages/plugin-api-map/src/agent-reference.ts:70`.
- Reload a map-group URL such as /plugins/plugin-api-docs/plugin-api/headless. Copy for agent inserts a rich Plugin Guide mention; plain @surface search is not advertised because this provider search returns an empty list. Verify resolution by pasting the copied mention into a synthetic turn. Source: `plugins/plugin-api-docs/app.tsx:57`, `plugins/plugin-api-docs/server.ts:8`, `packages/plugin-api-map/src/agent-reference.ts:53`.
