# Side chats

Status: **2026-09-05: 3 passed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Select a main-thread message/context and open Side chat; use a provider supporting the required fork operation.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/side-chat/package.json`
- `plugins/side-chat/server.ts`
- `plugins/side-chat/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Open and context | Create a side chat from selected context and inspect its compact panel and thread detail. | Hidden fork has the expected source-thread/checkpoint, shares the workspace, and stays out of the normal sidebar as intended. |
| Conversation | Send a harmless follow-up, navigate away/back, and reopen the side chat. | The side-chat conversation persists independently of the main composer. |
| Send back | Send a side-chat result back to the main thread and inspect its queue. | One intended message enters the parent’s delivery path with correct context; it is not silently sent to another thread. |
| Cleanup policy | Use dated empty/used test side chats in the dedicated cleanup fixture and exercise the hourly cleanup schedule through an isolated scheduler harness. | Only eligible old empty chats are archived; used chats and recent empty ones remain. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Verify sourceThreadId and checkpoint linkage on the hidden fork. Side chats have parentThreadId=null; they are source-linked forks, not child threads in BB parent/child notification semantics. Source: `plugins/side-chat/server.ts:99`.
- Cleanup is an hourly plugin background schedule (13 * * * *), with a 24-hour age threshold. No documented user CLI maintenance hook exists in this revision; use an owned dated-storage fixture and scheduler harness, and do not imply bb side-chat cleanup exists. Source: `plugins/side-chat/server.ts:135`.
