# Env-Daemon Core QA

Use this pass for changes to daemon supervision, session management, and runtime behavior shared across provider sessions.

## Covers

- multiple threads in one daemon
- multiple providers in one daemon
- one bad thread or provider does not block unrelated sessions
- completed threads do not leave the daemon in a broken state
- resumed work can reconnect to a surviving daemon cleanly

## Suggested checks

- run more than one active thread against the same daemon
- exercise more than one provider in the same daemon when touching provider routing or daemon glue
- verify a completed thread does not poison later work
- verify a resumed thread can reconnect to the correct runtime state

## Core scenarios

- multiple threads can run through one daemon without blocking each other
- when touching multi-provider routing, more than one provider can coexist in the same daemon
- a completed thread does not leave the daemon unable to service later follow-up work
- a restarted server can reconnect to a surviving daemon and continue supervising the active thread
- one misbehaving thread does not prevent unrelated threads from making progress

## High-value manual matrix

- spawn two threads attached to the same environment and run follow-ups on both
- confirm `thread sessions` on sibling threads converges to the same active env-daemon session where sharing is expected
- run one simultaneous follow-up round and confirm both turns complete cleanly
- archive one sibling and confirm the other still accepts follow-up work
- if daemon routing changed, run one multi-provider shared-environment scenario rather than only single-provider smoke
- if provider routing changed, interleave follow-ups across provider A and provider B in the same shared environment and confirm no event cross-contamination

## Existing automation

- `apps/server/src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-multi-thread-stress.test.ts`

## Related docs

- Standalone workflow: [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
- Env-daemon invariants: [`./invariants.md`](./invariants.md)
