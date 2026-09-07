<!-- GENERATED FILE — do not edit by hand.
     Source: packages/domain/src/thread-lifecycle.ts and
     packages/domain/src/environment-lifecycle.ts.
     Regenerate: pnpm --filter @bb/domain exec vitest run test/lifecycle-diagram.test.ts -u -->

# Lifecycle state machines

Rendered from `THREAD_LIFECYCLE` and `ENVIRONMENT_LIFECYCLE` — the
transition tables consumed by the CAS single-writers in `@bb/db`
(`applyThreadLifecycleEvent` / `applyEnvironmentLifecycleEvent`).

How to read these: each edge groups all events that transition between
the same two statuses. An event label is
`event ⟨supersession predicates⟩`; the predicates are checked against
the loaded row inside the writer's transaction, and a failing predicate
makes the event a logged no-op.
An **absent** edge means the event is a no-op in that status (the
writer returns `illegal-transition`). Recovery and callback-ordering
policy should be handled before events reach these tables.

## Thread

```mermaid
flowchart LR
    __start((start))
    pending["pending"]
    idle["idle"]
    starting["starting"]
    active["active"]
    stopping["stopping"]
    error["error"]
    __start --> starting
    pending -->|"run.preparing ⟨notArchived, notDeleted⟩"| starting
    idle -->|"run.preparing ⟨notArchived, notDeleted⟩"| starting
    idle -->|"run.started ⟨notArchived, notDeleted⟩"| active
    starting -->|"run.started ⟨notArchived, notDeleted⟩"| active
    starting -->|"run.succeeded"| idle
    starting -->|"run.failed ⟨notDeleted⟩"| error
    starting -->|"stop.requested"| stopping
    active -->|"run.succeeded"| idle
    active -->|"run.failed ⟨notDeleted⟩"| error
    active -->|"stop.requested"| stopping
    stopping -->|"stop.settled<br/>run.succeeded"| idle
    stopping -->|"run.failed ⟨notDeleted⟩"| error
    error -->|"run.preparing ⟨notArchived, notDeleted⟩"| starting
    error -->|"run.started ⟨notArchived, notDeleted⟩"| active
```

## Environment

```mermaid
flowchart LR
    __start((start))
    provisioning["provisioning"]
    ready["ready"]
    retiring["retiring"]
    error["error"]
    destroying["destroying"]
    destroyed["destroyed"]
    __start --> provisioning
    provisioning -->|"provision.succeeded<br/>provision.cancelled (workspace on disk)"| ready
    provisioning -->|"provision.failed"| error
    provisioning -->|"provision.cancelled (no workspace)"| destroying
    ready -->|"provision.requested"| provisioning
    ready -->|"retire.requested ⟨managed⟩"| retiring
    retiring -->|"retire.cancelled"| ready
    retiring -->|"destroy.started ⟨managed⟩"| destroying
    error -->|"provision.requested"| provisioning
    error -->|"destroy.started ⟨managed⟩"| destroying
    error -->|"destroy.completed ⟨matchingDestroyAttempt⟩"| destroyed
    destroying -->|"destroy.completed ⟨matchingDestroyAttempt⟩"| destroyed
    destroying -->|"destroy.failed ⟨matchingDestroyAttempt⟩"| retiring
    destroying -->|"destroy.lost"| error
```
