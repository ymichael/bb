# Approvals, questions, and permission escalation

Status: **2026-09-05: 2 passed, 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

A synthetic thread with a provider that can request command/file/plan approvals. Use harmless fixture writes. Never use live credentials or destructive commands.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/cli/src/commands/thread/interactions.ts`
- `apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionBanner.tsx`
- `apps/app/src/components/thread/pending-interactions/ThreadPendingInteractionUserQuestion.stories.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Command approval and denial | Request a harmless command under a restrictive permission mode; inspect interactions list/show; approve one and deny another. | Only the approved command runs; decision and execution appear in the same thread. |
| File-change review | Ask for a small fixture edit; inspect proposed diff, accept it, then reject a second edit. | Accepted bytes match the proposal; rejected bytes never appear on disk. |
| Permission escalation | Request a mode beyond the current thread allowance; exercise grant and deny under the host ceiling. | Grant cannot exceed the host ceiling; user-started and system-started turns follow their respective policy. |
| Question selection | Answer single-choice, multiple-choice, Other text, and multi-question cards through UI and interactions answer/respond. | Selected values return once to the waiting agent; empty and malformed answers are rejected appropriately. |
| Option previews and keyboard answers | Open an option preview and use the configured numbered answer shortcut. | Preview belongs to the selected option; shortcut acts on the current question rather than an old card. |
| Pending state, timeout, duplicate reply | Navigate away/back with a pending interaction, then resolve it; attempt a second response with the same ID. | Pending question survives navigation; already-resolved interactions cannot execute twice. |
| Plan interaction | Inspect a plan approval and respond through approve/deny. | Plan-specific decision is preserved; a generic question response cannot accidentally authorize it. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.
