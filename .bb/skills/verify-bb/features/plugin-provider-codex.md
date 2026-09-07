# Codex provider

Status: **2026-09-05: 1 passed, 6 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Installed/authenticated Codex on the disposable host. Use live catalogs; avoid committing private model labels in evidence.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/provider-codex/package.json`
- `plugins/provider-codex/server.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Selection and execution | Choose supported model/reasoning/service tier/permission combinations and run a short turn. | The actual session uses accepted options and rejects unsupported combinations at the boundary. |
| Plan and durable goal | Create a harmless plan and bounded goal, inspect progress, cancel/clear as appropriate. | Plan decisions and goal state remain distinct and survive supported continuation without invented completion. |
| Session controls | Fork, compact, edit at a checkpoint, rename/archive, stop/retry, and resume synthetic sessions. | Provider/session and BB thread state stay consistent; unsupported operations fail explicitly. |
| Tools and interactions | Drive a fixture file edit, command approval, and question card. | Correct interaction decisions reach the active turn once with no unapproved command execution. |
| Native memory and subagents | Toggle provider memory and native-subagent settings, then start a fresh task. | Instruction/tool exposure follows configuration and does not mutate an already running turn retroactively. |
| Skills and health | Resolve a native skill and inspect install/version/auth/usage through maintenance controls. | Host discovery and execution agree; errors distinguish unavailable CLI from missing authentication. |
| AI services | Use configured Codex-backed inference and transcription with harmless text/audio fixtures. | Results come from the selected service and errors are surfaced without leaking credentials. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
