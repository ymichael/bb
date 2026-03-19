# E2E Smoke QA

Use this pass for a thin cross-system sanity check after cross-cutting or user-visible changes.

## Covers

- project create and thread spawn still work together
- one follow-up path still works
- one worktree or shared-environment flow still works
- one provider-backed tool or richer turn path still works

## Smoke scenarios

- create a disposable project and spawn a local thread
- send a follow-up after idle and confirm it settles cleanly
- run one worktree or shared-environment path
- run one richer provider-backed path such as dynamic tools
- if the change is restart-sensitive, include one restart sanity check rather than the full recovery matrix

## Current automation

The current closest checked-in entrypoints are still named under `qa:server:*`:

```bash
pnpm qa:server:manual-smoke
pnpm qa:e2e:smoke
pnpm qa:providers:smoke:claude-code
pnpm qa:providers:smoke:pi
```

`qa:e2e:smoke` is now the top-level alias for the existing e2e smoke path. Provider-specific smoke aliases are available for Claude Code and Pi.

Relevant automated slices include:

- `apps/server/src/__tests__/e2e/standalone-server-cli-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/standalone-server-blocked-restart.test.ts`
- `apps/server/src/__tests__/e2e/thread-immediate-followups-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/dynamic-tools-server-roundtrip.test.ts`

Related docs:

- [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
