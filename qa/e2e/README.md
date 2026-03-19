# E2E QA

E2E QA is the top-layer assembled-system smoke pass.

It should answer one question:

- does the product still basically work end-to-end?

It should not be the primary home for subsystem-specific restart, provider protocol, or env-daemon recovery depth.

Default pass:

- [`./smoke.md`](./smoke.md)

Fastest scripted entrypoint:

- `pnpm qa:e2e:smoke`
