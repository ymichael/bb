# CLI Core QA

Use this pass for changes to CLI commands, output semantics, and operator workflows.

## Covers

- project create/list/files
- thread show/status/log/output flows
- follow-up and control-plane commands behaving coherently
- usable operator feedback around restart or failure conditions

## Core scenarios

- `server health` succeeds against the target server
- `project create`, `project list`, and `project files` all behave coherently
- `thread show`, `thread status`, `thread log`, and `thread output` present a consistent picture of one thread
- `thread tell --mode steer` behaves correctly when an active turn exists
- `thread stop`, `thread archive`, and `thread unarchive` return explicit operator-visible outcomes

## Useful inspection helpers

```bash
node apps/cli/dist/index.js thread wait <thread-id> --status idle --timeout 90
node apps/cli/dist/index.js thread wait <thread-id> --event turn/started --timeout 30
node apps/cli/dist/index.js thread sessions <thread-id>
node scripts/qa/thread-summary.mjs <thread-id>
node apps/cli/dist/index.js thread status <thread-id> --recent-events 10 --event-mode raw --include-low-signal
node apps/cli/dist/index.js thread log <thread-id> --json
node apps/cli/dist/index.js thread output <thread-id>
```

## Current automation

```bash
pnpm qa:cli:smoke
pnpm qa:cli:core
```

`qa:cli:core` currently covers:

- CLI-driven thread spawn
- immediate follow-up after idle
- archive / unarchive control-plane behavior

## Notes

- Many CLI checks still live inside older standalone server flows.
- As those scenarios are split out, CLI-oriented checks should land here rather than in umbrella server docs.

## Related docs

- [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
