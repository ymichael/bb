# Fallback question cards

Status: **2026-09-05: 3 passed, 1 failed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Enable the plugin with a provider lacking native question support, then repeat with a native-capable provider. See interactions.md for core decisions.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/ask-user-question/package.json`
- `plugins/ask-user-question/src/server.ts`
- `plugins/ask-user-question/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Fallback tool availability | Ask the agent to request a preference and inspect its actual tool call. | Fallback tool appears only where required; a native provider keeps its native question flow. |
| Single and multiple selection | Ask for single-choice and multi-select questions, select answers, and submit. | Returned selection matches the card and arrives once in the waiting turn. |
| Other and previews | Enter a freeform Other response and inspect an option with a multiline preview. | Typed response and selected preview belong to the correct question; keyboard input remains usable. |
| Multiple questions and bounds | Request a multi-question card; exercise schema boundaries from src/server.ts and malformed tool input. | Valid grouped answers retain their question IDs; invalid counts/options fail at the boundary. |
| Dismissal and timeout | Dismiss one question and leave another to its documented timeout; navigate away/back with a third pending. | Resolution allows the agent to continue under the specified empty-answer policy; no duplicate pending card remains. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
