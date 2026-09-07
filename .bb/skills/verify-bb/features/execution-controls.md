# Active turns, queues, plans, goals, and recovery

Status: **2026-09-05: 3 passed, 11 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

An authenticated provider and synthetic workspace; use short bounded turns. Save IDs and monitor thread show, output, and log. Capability-dependent rows need the specific provider.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/cli/src/commands/thread/actions.ts`
- `apps/cli/src/commands/thread/organization.ts`
- `apps/cli/src/commands/thread/wait.ts`
- `apps/cli/src/commands/thread/pending-todos.ts`
- `apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionBanner.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Send and follow up | Run thread-lifecycle, then send a second message with thread tell and the UI. | Messages remain in the same thread with distinct turn boundaries and final outputs. |
| Steer active work | During a bounded active turn send a steer through the configured UI control and thread tell flags from help. | Steer reaches the intended turn according to provider semantics; no dropped or duplicate prompt. Record whether the provider cancels/re-prompts or steers live. |
| Queue create, edit, delete | Queue two messages during work, edit one, delete the other, and compare thread queue list/update/delete. | Payload and order match UI; deleted messages never dispatch. |
| Queue ordering and grouped prefix | Reorder three queued messages and set the grouped prefix with queue reorder/group; finish the live turn. | Dispatch follows the persisted order/grouping exactly once. |
| Send queued now and timed sends | Use Send now on a waiting message and compare queue send; inspect time-zone behavior for a scheduled message. | Chosen queued item is removed only after the correct dispatch and is not sent twice. |
| Stop and release | Stop a bounded live task through UI and thread stop; then send a new follow-up. | Execution stops, runtime is released as specified, and the same thread can resume without stale active state. |
| Retry a failed turn | Use a reproducible provider setup failure, correct it, and select retry / thread retry. | Failure remains visible; retry produces a new valid attempt with preserved user content. |
| Plan approval and cancel-plan | Request a supported plan, inspect pending state, approve or reject it, then repeat and invoke cancel-plan. | Decision reaches the provider and the plan indicator exits; rejection does not silently implement the plan. |
| Durable goal and clear-goal | Use a provider supporting goals with a small measurable task; inspect goal status, then clear an active goal. | Goal state and continuation agree with the provider; clear stops goal-driven continuation. |
| Compaction and clear context | On idle/failed threads call compact and clear separately; follow up afterward. | Provider reports completion or unsupported action; BB does not invent a successful compaction. |
| Todo and context indicators | Inspect thread show --json pendingTodos and the context ring during a multi-step synthetic turn; expand details. | Counts, plan/todo states, and supported usage data agree with timeline events. |
| Wait, logs, output, counts | Exercise thread wait/show/log/output/count/list over idle, active, failed, and missing IDs. | Timeouts and terminal states are distinct; pagination and output refer to the requested thread. |
| Reconnect and late events | Briefly disconnect only the QA daemon during a turn; reconnect and inspect events after completion. | History is not duplicated; completion remains terminal; a late update cannot silently create a phantom active turn. |
| Running state and event wait | Use SDK threads.listRunning and threads.events.wait with bounded cursors while a synthetic turn streams, finishes, and reconnects. | Events preserve order and identity; running state settles correctly, and a timeout is distinguished from completion. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- Inspect thread show --json pendingTodos and the context ring; pending-todos is an internal helper, not a CLI command. Source: `apps/cli/src/commands/thread/show.ts:313; apps/cli/src/commands/thread/pending-todos.ts`.
- Use SDK threads.listRunning and threads.events.wait with bounded cursors; there is no standalone running or events CLI command in this revision. Source: `packages/sdk/src/areas/threads.ts; apps/cli/src/commands/thread/show.ts`.
