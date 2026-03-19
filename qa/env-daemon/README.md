# Env-Daemon QA

This surface owns runtime supervision behavior inside the environment daemon.

Owned areas:

- multiple providers and multiple threads in one daemon
- isolation when one thread or provider misbehaves
- non-blocking behavior across sessions
- reconnect and replacement behavior
- cleanup, leak, and long-lived runtime health

Default pass:

- [`./core.md`](./core.md)

Deeper pass:

- [`./recovery.md`](./recovery.md)
- [`./invariants.md`](./invariants.md)
- [`./regressions.md`](./regressions.md)

Fastest available scripts today:

- `pnpm qa:env-daemon:core`
- `pnpm qa:env-daemon:recovery`
- `pnpm qa:env-daemon:recovery:fake`

Use `core.md` when you need the shared-runtime checklist that is broader than restart-only recovery.
The default recovery alias currently points at the deterministic fake-provider suite, because exact worker-loss injection is not yet a clean real-provider scripted pass.
