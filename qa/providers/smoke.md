# Provider Smoke QA

Use this pass for the fastest provider-level sanity check.

## Covers

- one successful single-turn request
- provider id is surfaced correctly in thread data and raw events
- one follow-up turn succeeds

## Smoke scenarios

- spawn one thread and wait for `idle`
- confirm `thread show` reports the expected `providerId`
- confirm raw provider event envelopes carry the expected `providerId`
- send one follow-up and confirm it settles cleanly

## Current automation

```bash
pnpm qa:providers:smoke
pnpm qa:providers:smoke:claude-code
pnpm qa:providers:smoke:pi
```

These aliases map to the existing checked-in provider smoke coverage.
