# Provider Core QA

Use this pass when changing provider bridges, protocol handling, or request/response behavior.

## Shared provider matrix

- single-turn behavior
- multi-turn behavior
- context preservation across turns
- system instruction handling
- dynamic tool delivery across turns
- provider-visible error handling

## Suggested shared checks

- verify one exact-output single-turn request
- verify one multi-turn conversation preserves prior context
- verify system instructions are respected across turns
- verify dynamic tools remain available when the flow requires them
- verify provider errors surface as explicit failures rather than silent hangs or false success
- verify `thread show` and raw provider envelopes report the expected `providerId`

## Provider-specific overlays

- use `qa/providers/pi/README.md` only for Pi-specific setup or exclusions
- use `qa/providers/claude-code/README.md` only for Claude Code-specific setup or exclusions
- keep shared scenario depth here unless the provider truly diverges

## Existing automation

- `pnpm qa:providers:core`
- `apps/server/src/__tests__/e2e/dynamic-tools-server-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/codex-dynamic-tools-server-roundtrip.test.ts`
- provider-specific smoke entrypoints in the root `package.json`

## How to run

1. Run the shared provider matrix in this doc.
2. Apply the relevant provider overlay if the provider has setup quirks or special cases.

## Current automation

Use the currently available provider-specific smoke entrypoints plus the deeper server/env-daemon flows when the change touches provider runtime integration:

```bash
pnpm qa:providers:core
pnpm qa:providers:smoke
pnpm qa:providers:smoke:claude-code
pnpm qa:providers:smoke:pi
```

`qa:providers:core` currently gives explicit scripted coverage for:

- one single-turn spawn path
- one immediate follow-up / multi-turn path
- one dynamic-tools path

It does not yet give a dedicated scripted check for system instructions or provider-visible error handling. Keep those in the shared manual matrix until we add first-class scripted slices for them.

If the provider change also touches daemon/tool-call runtime behavior, add:

```bash
pnpm qa:env-daemon:core
pnpm qa:env-daemon:recovery
```

Use the recovery pass when you specifically need deterministic worker-loss or reconnect coverage.

## Related docs

- Standalone workflow: [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
