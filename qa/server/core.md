# Server Core QA

Use this pass for changes to server routes, persisted lifecycle behavior, and server-owned restart/resume semantics.

## Covers

- routing and API contract sanity
- persisted thread state converging correctly
- resume of existing threads after restart
- graceful shutdown and restart from the server's point of view
- server-side reconciliation with existing env-daemon sessions

## Suggested checks

- create project, inspect project, inspect files
- spawn a thread and verify state/output through CLI
- restart the standalone server and confirm existing threads remain inspectable
- confirm resumed thread state is coherent after restart
- verify follow-up work still routes through the expected server surfaces

## Core scenarios

- project create, list, and file inspection succeed against the standalone server
- thread spawn reaches a coherent terminal state visible through `thread show`, `thread status`, and `thread output`
- a follow-up after idle is accepted and settles cleanly
- `thread tell --mode steer` works once a real `turn/started` event exists
- `thread stop` leaves the thread in a recoverable state and a later follow-up still works
- server restart does not make existing thread state ambiguous or uninspectable
- a resumed thread can still accept expected follow-up work after restart

## Operator checks

- prefer `thread wait`, `thread show`, `thread status`, `thread log`, and `thread output` before falling back to SQLite
- if CLI-visible state and persisted state disagree, treat that as a server-owned bug candidate
- when validating restart or resume, record whether the server made the thread recover, remain active, or settle into explicit `error`

## Automation today

Current automation is still named with the old server-centric scheme:

```bash
pnpm qa:server:manual-smoke
pnpm qa:server:core
pnpm qa:server:smoke
pnpm qa:server:stress
pnpm qa:server:regression
```

`qa:server:core` gives explicit scripted coverage for:

- thread spawn visibility through CLI/API
- immediate follow-up after idle
- archive / unarchive control-plane behavior

Add the standalone workflow or `qa/server/recovery.md` when the change is restart-sensitive.
For deterministic restart and worker-loss behavior, prefer `pnpm qa:server:recovery:fake` or the env-daemon recovery pass instead of assuming `qa:server:stress` is the default recovery path.

## Related docs

- Standalone workflow: [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
- Server invariants: [`./invariants.md`](./invariants.md)
