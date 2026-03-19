# Provider QA

Provider QA is shared-first.

Use the shared provider docs for the common matrix across all providers. Use provider-specific overlays only for setup quirks, exclusions, or provider-specific regressions.

Shared passes:

- [`./smoke.md`](./smoke.md)
- [`./core.md`](./core.md)

Provider overlays:

- [`./codex/README.md`](./codex/README.md)
- [`./claude-code/README.md`](./claude-code/README.md)
- [`./pi/README.md`](./pi/README.md)

Interpretation:

- "run provider QA" means run the shared provider pass
- "run QA for the Pi provider" means run the shared provider pass, then apply the Pi overlay

Fastest scripted entrypoints:

- shared provider smoke: `pnpm qa:providers:smoke`
- shared provider core: `pnpm qa:providers:core`
- dynamic-tool provider roundtrip: `pnpm qa:providers:dynamic-tools`
- Claude Code smoke: `pnpm qa:providers:smoke:claude-code`
- Pi smoke: `pnpm qa:providers:smoke:pi`

Use `core.md` when the change affects provider protocol behavior, not just bridge liveness.
