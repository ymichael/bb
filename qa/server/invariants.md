# Server Invariants

These are the durable server-owned behaviors that QA should assert.

Use these invariants when writing new server QA scenarios or deciding whether a failure belongs to `server/` or `env-daemon/`.

## Principles

- assert eventual state and explicit transitions, not fragile timing details
- prefer supported CLI and API surfaces over raw DB checks for first-line validation
- use SQLite or logs as supporting evidence when operator-visible surfaces are insufficient

## Invariants

### 1. CLI-visible state and persisted state converge

For a given thread, the operator-facing surfaces and the persisted server state must eventually agree.

Examples:

- `thread show` and `thread status` should not disagree on the settled terminal state
- persisted thread state should converge to the same healthy or error terminal state shown by the CLI

### 2. A thread must not silently skip required lifecycle work

The server must not make a thread look healthy without the lifecycle evidence needed to justify that outcome.

Examples:

- a new thread should not appear complete without a real run or turn sequence
- a restart near provisioning must not silently land in `idle` if no real turn ever ran

### 3. Restarted server state must remain inspectable and recoverable

After server restart, thread state must remain inspectable and the operator must be able to recover or continue through supported commands.

Examples:

- a restarted thread should still be visible through `thread show`, `thread log`, and `thread output`
- a follow-up after restart failure should be accepted once the thread reaches an explicit recoverable state

### 4. Administrative actions preserve control-plane correctness

Control-plane actions must not leave contradictory thread state behind.

Examples:

- stop then follow-up still works
- archive blocks new work while archived
- unarchive does not leave the thread unusable
- promote and demote reflect the actual underlying environment state
