# CLI QA

This surface owns operator-facing command behavior.

Owned areas:

- command routing and output behavior
- inspection and status flows
- resilience around server restarts and partial failure

Default pass:

- [`./core.md`](./core.md)

Current state:

- CLI guidance is documented here
- CLI smoke automation is available via `pnpm qa:cli:smoke`
- CLI-specific automation is still thinner than the other surfaces
- use [`../shared/coverage-audit.md`](../shared/coverage-audit.md) to track the next depth increases we still want
