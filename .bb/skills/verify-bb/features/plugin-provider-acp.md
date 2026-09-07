# ACP providers

Status: **2026-09-05: 2 passed, 4 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Enable provider-acp; use installed/authenticated test ACP executables. Provider choices come from current host discovery and custom configuration.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/provider-acp/package.json`
- `plugins/provider-acp/server.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Discovery and configuration | Inspect built-in discovery and add a harmless custom ACP config using its schema. | Installed/configured providers appear with accurate health; malformed config fails explicitly. |
| Model and reasoning discovery | Open pickers and refresh a provider’s live catalog. | Available models and reasoning match capabilities without hardcoded historical names. |
| Turn lifecycle | Run thread-lifecycle, streaming, tool interaction, stop, and follow-up with the test ACP provider. | Protocol events map to correct thread state and supported permission behavior. |
| Steer and queue | Steer while active, then send a queued follow-up; inspect actual provider session events. | Cancellation/continuation semantics match the current ACP adapter; late updates do not reopen a finished turn. |
| Permissions and questions | Exercise declared permission modes and native/fallback interactions. | Unsupported modes are rejected; approval and answer boundaries reach the active provider session. |
| Skills, authentication, failures | Resolve a native skill, test missing login/executable and a broken ACP process. | Skills and health follow host capability; failure remains inspectable with a recoverable thread state. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Custom agents use an unprefixed slug in id; BB prefixes it with acp-. Discover the resulting provider ID from the live catalog before spawning. Configure through plugin config provider-acp customAgents and restore the original string afterward. Source: `plugins/provider-acp/src/agents.ts:9`.
