# Claude Code provider

Status: **2026-09-05: 2 passed, 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Installed/authenticated Claude Code on the disposable host; provider settings are under its plugin detail.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/provider-claude-code/package.json`
- `plugins/provider-claude-code/server.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Capabilities and selection | Inspect discovered models/reasoning and supported accept-edits/auto/full modes; start a short turn. | Execution honors selected supported settings and correctly reports unavailable CLI/auth. |
| Plans, questions, and tools | Drive a harmless plan, native question, and fixture edit under review. | Native decisions and tool results return to the right session with correct permission limits. |
| Session operations | Fork at a supported checkpoint, compact, stop/retry, and continue after idle release. | History/session ancestry and resumability follow actual supported operations without duplicate output. |
| Native skills and memory | Select a native skill and change the native-memory/CLAUDE.md setting using a fixture instruction. | Subsequent sessions include only the intended configured native context. |
| Task and workflow controls | Toggle native Task and workflow delegation settings on test sessions. | Exposed tools match configuration; disabled delegation is not accepted and ignored. |
| Chrome integration | With the required browser integration installed, enable its setting and run a harmless local page read. | Capability is available only with its prerequisite and targets the intended browser. |
| Maintenance | Inspect CLI version, install/health and usage refresh on a disposable host. | Status reflects real provider maintenance results; failures are distinct from no update/zero usage. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
