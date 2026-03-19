# Server QA

This surface owns server-side invariants that are primarily about the server itself rather than env-daemon runtime behavior.

Owned areas:

- routing and API behavior
- persisted thread state and resumption
- graceful shutdown and restart behavior from the server's perspective
- server-side reconciliation of existing session state

Default pass:

- [`./core.md`](./core.md)

Deeper pass:

- [`./recovery.md`](./recovery.md)
- [`./invariants.md`](./invariants.md)
- [`./regressions.md`](./regressions.md)

Fastest available scripts today:

- `pnpm qa:server:manual-smoke`
- `pnpm qa:server:smoke`
- `pnpm qa:server:stress`
- `pnpm qa:server:recovery:fake`

There is not yet a fully honest `qa:server:core` alias. Use `qa:server:smoke` for the real-provider baseline, and treat `qa:server:stress` as supplemental transitional coverage rather than the main recovery path. For deterministic restart and worker-loss behavior, prefer `qa:server:recovery:fake` or `qa/env-daemon/recovery.md`, depending on ownership.

If a scenario is really about multi-provider session runtime, thread isolation inside one daemon, or worker-loss handling mechanics, it likely belongs in `qa/env-daemon/` instead.
