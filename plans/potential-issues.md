# Potential Issues

## Open

1. `[P1]` Send follow-up thread messages in auto mode (`apps/cli/src/commands/thread.ts:253`)
   The new `bb thread steer` command always posts `mode: "steer"`, which the daemon rejects when the target thread is idle (`no active turn`). Since this replaced `thread tell`, there is no CLI path to send a normal follow-up message to an idle thread.
2. `[P2]` Forward explicit role metadata on thread spawn (`apps/daemon/src/routes/threads.ts:61`)
   The spawn schema accepts `agentRoleId` and `developerInstructions`, but this route currently only forwards role-derived values from `roleId`. Requests that send explicit fields without `roleId` silently lose metadata/instructions.
3. `[P2]` Fix no-turn-id completion dedupe key (`apps/daemon/src/thread-manager.ts:1152`)
   The no-turn-id fallback dedupe compares `lastSeq` and `event.seq`, but sequence numbers are monotonic per event and cannot collapse duplicate completion notifications for the same turn.
4. `[P2]` Validate parent thread project before auto-notifying (`apps/daemon/src/thread-manager.ts:1142`)
   Child completion notifications are sent to `parentThreadId` without verifying parent/child project match. A stale or mismatched parent link can inject a system message into an unrelated project thread.
