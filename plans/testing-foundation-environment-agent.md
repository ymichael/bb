# Goal

Describe the high-level testing approach Beanbag should move toward as the environment-agent transport work lands, focusing on the principles the test architecture should satisfy and the gaps in the current setup that need to be closed.

This plan is intentionally durable. It should remain useful even if package boundaries, implementation details, or temporary migration steps change.

# Scope

In scope:

- Define the testing principles that should guide the post-migration architecture
- Identify the main weaknesses in the current test setup
- Describe the structural changes needed so end-to-end and regression coverage can grow with the product
- Define the kinds of behaviors that should become permanent, stable regression targets
- Clarify what should be treated as core contract coverage versus supporting unit and integration coverage

Out of scope:

- Implementing the new harnesses immediately
- Setting numeric coverage targets
- Designing a broader browser/UI testing strategy
- Replacing the transport migration plan itself

# Implementation Steps

1. Record the current state the plan needs to evolve from

- The environment-agent path is no longer hypothetical:
  - protocol, client, runtime, and HTTP transport code already exist
  - host-managed environment-agent startup and target resolution already exist
  - the CLI can already run an environment-agent HTTP service
  - daemon routes and orchestration already expose environment-agent delivery and replay concepts
- The current test setup therefore has real momentum in the new direction, but the regression strategy is still split:
  - newer transport-oriented tests exist
  - older daemon end-to-end coverage is still centered on a fake provider runtime
- The plan should preserve what is already valuable while making sure the long-term testing center of gravity moves to the new boundary instead of staying stuck on the old one

2. Define the principles the future test architecture should satisfy

- The primary end-to-end boundary should match the real product architecture rather than an older implementation detail.
- Stable behavioral contracts should be tested explicitly and independently from happy-path product flows.
- High-value regression tests should assert durable external behavior, not incidental internal mechanics.
- Test infrastructure should make new lifecycle scenarios cheap to add and easy to understand.
- Shared lifecycle behavior should be validated once and reused across environment implementations, instead of being re-specified from scratch for each one.
- Failure, recovery, replay, and retry semantics should be treated as first-class product behavior, not edge-case cleanup.

3. Capture the gaps in the current setup

- The environment-agent area has meaningful test coverage already, but it is still mostly proving local mechanics rather than serving as the main regression backbone.
- Too much of the current daemon end-to-end foundation is still oriented around the daemon owning or simulating a direct provider child process, which is no longer the intended long-term architecture.
- Existing end-to-end coverage proves a few valuable happy paths, but it does not yet provide a broad reusable regression matrix for lifecycle, failure, and recovery behavior.
- Current fake runtime behavior is useful, but too scenario-specific and provider-shaped to serve as the long-term foundation for growing transport-level tests.
- Some high-value behavior is covered only through narrow unit or integration tests, which means the most important cross-boundary guarantees are not yet locked in at the system level.
- Recovery-oriented behaviors such as reconnect, replay, duplicate delivery, and idempotent retry are not yet the center of the regression strategy.
- The repo now has multiple overlapping test centers:
- protocol/runtime transport tests
- environment wiring tests
- orchestrator integration tests
- fake-provider daemon end-to-end tests
  The gap is not a lack of tests; it is the lack of a clear long-term hierarchy between them.
- The current state suggests three concrete deficiencies to address:
  - transport-oriented tests exist, but they are not yet the main source of system confidence
  - end-to-end helpers are still optimized for provider-process scenarios instead of environment-agent conversations
  - there is no explicit shared lifecycle matrix that new environments or transport changes can inherit

4. Re-center test architecture around stable contracts

- Move the critical-path regression story toward the daemon talking to an environment-agent boundary, because that is the architecture the repo is moving to.
- Keep lower-level translation logic covered with focused contract tests, but do not rely on those tests alone to prove lifecycle correctness.
- Treat protocol shape, sequencing, replay rules, and idempotency as stable contracts that deserve dedicated test coverage.
- Treat lifecycle state transitions, queue behavior, stop/retry semantics, and externally visible error handling as stable contracts that deserve dedicated regression coverage.
- Treat direct provider child-process details as transitional implementation coverage rather than the long-term end-to-end contract.

5. Clarify the target test hierarchy

- The long-term hierarchy should look like this:
  - protocol and transport contract tests prove the language of the system
  - focused integration tests prove environment and daemon wiring
  - a reusable simulator-driven regression suite proves lifecycle and recovery behavior across the main architectural boundary
  - heavier environment-backed coverage proves a small number of real provisioning and connectivity facts
- This hierarchy matters because it prevents the suite from collapsing into either:
  - lots of narrow unit tests with weak system confidence
  - lots of expensive end-to-end tests with poor debuggability

6. Turn the strategy into phased workstreams

- Phase 1: Consolidate the transport contract foundation
  - keep expanding protocol/runtime/client coverage around sequencing, ack, replay, and delivery semantics
  - make these tests the canonical place to define transport rules
  - avoid encoding daemon-specific fallback behavior into these contract tests
- Phase 2: Refactor the existing end-to-end harness toward the new boundary
  - evolve the current daemon test harness so the primary fake is an environment-agent conversation rather than a fake provider process
  - keep enough compatibility to avoid blocking current work while the migration is still in motion
  - preserve the current happy-path smoke coverage while redirecting future investment into the new harness
- Phase 3: Define and land the shared lifecycle regression matrix
  - codify the small set of lifecycle scenarios that every environment-agent-backed execution path must satisfy
  - add reusable scenario builders and shared assertions so the suite grows by adding scenarios, not by copying setup code
  - make new transport regressions enter through this matrix by default
- Phase 4: Add targeted real-environment confidence checks
  - keep a smaller set of provisioning and connectivity tests for real environment implementations
  - use these to prove environment-specific facts, not to carry the full lifecycle regression burden
- Phase 5: Simplify and retire legacy-path assumptions
  - stop growing fake-provider-centric daemon end-to-end tests once the new harness is credible
  - retain only the coverage that is still uniquely valuable during the migration
  - remove duplicated coverage when the environment-agent path is clearly authoritative

7. Introduce a reusable simulator-driven foundation

- Replace ad hoc happy-path test doubles with a scripted simulator that can model the full lifecycle of commands, events, sequencing, disconnects, replay, and retries.
- Prefer explicit scenario builders over per-test bespoke setup so new behaviors can be expressed as variations of an agreed testing language.
- Ensure the simulator is neutral about specific environment implementations so the same lifecycle expectations can be reused across host-backed and future remote environments.
- Keep the simulator focused on behavior and contract fidelity rather than becoming a second production implementation.
- In the near term, this likely means evolving the existing fake runtime infrastructure rather than deleting it outright, but changing its shape so the important abstraction is the environment-agent conversation, not a provider process.
- The simulator should eventually support at least these primitives:
  - expect command
  - reply success
  - reply error
  - emit event sequence
  - disconnect
  - reconnect
  - replay from cursor
  - duplicate event delivery
  - delayed readiness or delayed delivery

8. Define the first concrete deliverables for the new foundation

- A reusable simulator helper with typed scenario steps
- Shared assertion helpers for:
  - thread status
  - replay cursor position
  - timeline and persisted event checks
  - queued follow-up state
  - externally visible route behavior
- A first lifecycle matrix that includes:
  - spawn success
  - follow-up success
  - stop during active work
  - duplicate completion handling
  - reconnect and replay after downtime
  - retry-safe delivery or idempotent resend
- A clear rule for where future tests should go:
  - protocol rule changes extend contract tests
  - lifecycle rule changes extend the shared regression matrix
  - environment-specific provisioning changes extend environment-specific checks
  - narrow internal edge cases stay in focused integration tests

9. Define the core regression suites that should exist over time

- Contract coverage for protocol-level behavior:
  - command validation
  - event decoding
  - closed/internal union handling
  - monotonic sequencing
  - replay-from-cursor behavior
  - ack and idempotency semantics
  - disconnect and recovery semantics
- Contract coverage for lower-level translation behavior:
  - request shaping
  - event normalization
  - status mapping
  - output extraction
  - filtering rules for persistence and broadcast
- End-to-end lifecycle regression coverage:
  - thread spawn success
  - follow-up success
  - stop during active work
  - queued follow-up dispatch after completion
  - duplicate or missing lifecycle events
  - upstream/runtime error propagation
  - disconnect during active work
  - reconnect and replay after daemon restart
  - resume with existing and missing upstream state
- As these suites stabilize, new work should prefer adding scenarios to the shared lifecycle matrix rather than inventing one-off tests in new places.

10. Define what good assertions look like

- Prefer assertions on:
  - persisted thread state
  - persisted event and timeline state
  - queue state
  - replay position and deduplication behavior
  - externally visible API behavior
- Avoid building the long-term regression suite around:
  - incidental call counts
  - private helper behavior already covered elsewhere
  - transport implementation details that are expected to change during migration

11. Make shared lifecycle coverage reusable across environment kinds

- The same high-value lifecycle expectations should be reusable across current host-backed execution and future remote execution.
- Environment-specific tests should focus on what is unique about provisioning, reachability, capabilities, and cleanup.
- Shared lifecycle semantics should not be redefined differently for each environment kind.
- New environment kinds should inherit an existing regression matrix rather than requiring a new testing approach.
- The immediate implication for the current repo state is that new host-backed environment-agent tests should be written so they naturally generalize to docker rather than quietly reintroducing host-only assumptions.
- A practical decision rule:
  - if a scenario is about transport or lifecycle semantics, write it once in the shared matrix
  - if a scenario is about provisioning mechanics or reachability for one environment kind, keep it environment-specific

12. Plan CI around confidence levels, not just one big test bucket

- Keep fast unit and integration coverage on the default path.
- Add a dedicated deterministic regression lane for transport and lifecycle behavior once the simulator foundation exists.
- Add heavier environment-backed coverage only after the shared simulator-driven suite has already locked in the common lifecycle guarantees.
- Use CI structure to keep the suite understandable as it grows, rather than flattening every style of test into one path.
- As the current transport-oriented tests mature, CI should make it obvious which lane failed:
  - protocol/contract failure
  - wiring/integration failure
  - lifecycle regression failure
  - real environment-backed failure

13. Be explicit about what should wait until the migration stabilizes

- Do not over-invest in large numbers of new fake-provider daemon end-to-end tests.
- Do not cement a simulator API that mirrors temporary transport implementation details.
- Do not spread replay and idempotency semantics across many test files before the rules settle.
- Do not add heavy docker-backed regression coverage until the shared simulator-driven lifecycle suite is already trusted.
- Prefer leaving some narrow coverage in existing integration tests temporarily rather than forcing premature consolidation.

# Validation

- The repo has a written testing direction that still makes sense even if implementation boundaries shift during migration.
- New transport and environment work can add tests into a stable structure instead of inventing patterns case by case.
- The plan reflects the repo’s current partial environment-agent landing rather than pretending the migration has not started yet.
- The most important architectural contracts are identified clearly enough to become explicit suites later.
- The future regression strategy is centered on lifecycle, replay, retry, and recovery behavior rather than only happy-path execution.
- Shared lifecycle guarantees can be reused across multiple environment implementations with limited environment-specific branching.
- The plan is specific enough that later implementation work can be broken into discrete tasks without redefining the strategy first.

# Open Questions/Risks

- If the new transport boundary accumulates too much provider-specific behavior, the test plan could preserve the same coupling under a new name.
- If the simulator becomes too tied to one environment implementation, it will stop being a durable foundation for shared lifecycle coverage.
- Replay, ack, and idempotency semantics may continue to evolve during the migration, which means some high-value regression cases should not be fully cemented until those rules stabilize.
- There will likely be a temporary period where legacy-path and new-path tests coexist; the main risk is accidentally treating that duplication as the permanent testing model.
- The current fake provider/runtime harness is still useful during migration, but the plan should not allow it to remain the long-term center of end-to-end strategy once the environment-agent path becomes authoritative.
- Because the environment-agent path now exists in partially landed form, there is also a risk of declaring victory too early and never consolidating the suite around the new boundary.
