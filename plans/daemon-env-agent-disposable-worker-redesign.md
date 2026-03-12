# Goal

Redesign the daemon `<->` environment-agent architecture so the daemon is the single lifecycle coordinator and the environment-agent becomes a disposable worker instead of a semi-autonomous peer.

The intended end state is:

- the daemon is the only owner of thread lifecycle, recovery policy, command state, and session validity
- `packages/environment` only provisions workspaces and launches/stops agents
- `packages/environment-agent` only executes commands, emits events, and reports local process state
- missing env-agent state is a normal idle condition, not an exceptional recovery path
- daemon-owned environment preparation is distinct from env-agent-dependent provider bootstrap/execution
- `provisioned` is a real persisted thread status between `provisioning` and `active`

# Scope

In scope:

- Redefining ownership between `apps/daemon`, `packages/environment`, and `packages/environment-agent`
- Removing env-agent lifecycle policy such as self-suspend and multi-path reconnect logic
- Removing process-discovery/state-file logic that acts as a parallel source of truth
- Simplifying the daemon `<->` agent transport/session model around one canonical command-and-event stream
- Reworking tests around durable product guarantees instead of choreography
- Updating architecture and contract docs to reflect the new model

Out of scope:

- UI redesigns unrelated to lifecycle stability
- Broad provider API redesign beyond what is needed to support daemon-owned recovery
- Incremental compatibility shims that preserve every old lifecycle behavior indefinitely

# Implementation Steps

1. Commit to the target model explicitly in docs before further implementation.

- Update the architecture docs to define the env-agent as a disposable worker.
- State clearly that the daemon is the sole owner of:
  - whether an agent should exist
  - when an agent is replaced
  - whether in-flight work is retried or failed
  - provider-session resume versus reprovision decisions
- State clearly that the environment layer does not own session policy and the env-agent does not own lifecycle policy.
- Clarify that `provisioning` is not one monolithic phase:
  - environment/workspace preparation is daemon-owned
  - provider bootstrap is env-agent-dependent
- Define persisted `provisioned` between `provisioning` and `active` to represent “environment ready, provider bootstrap next”.

2. Replace the current split lifecycle with one daemon-owned execution path.

- Introduce one canonical daemon path for work dispatch:
  - load thread state
  - ensure environment exists
  - start agent if absent
  - establish one live control stream to the current agent instance
  - reattach or recreate provider state according to daemon policy
  - dispatch command
- Remove special cases that separately:
  - restore environment runtime
  - await active session
  - rebind queued commands to replacement sessions
  - retry `prepare()` to paper over disappearing agent targets

3. Simplify the env-agent transport into one live stream.

- Replace the current “daemon persists queue, agent long-polls for commands, agent separately pushes events/results” shape with one coherent stream.
- The stream should carry:
  - daemon-to-agent commands
  - agent-to-daemon command acknowledgements/results
  - agent-to-daemon provider events
  - heartbeats or liveness only if still needed after simplification
- Keep per-thread ordering and idempotent command ids, but remove broker-like semantics that require command rebinding across sessions.
- Prefer a single long-lived connection model over multiple poll/push paths.

4. Remove env-agent lifecycle policy entirely.

- Delete self-suspend behavior from `packages/environment-agent`.
- Delete any logic where the env-agent decides it should exit because it believes the thread is quiescent.
- If drain-aware shutdown is useful, make it daemon-initiated with an explicit command or close handshake.
- Keep only local mechanics in the agent:
  - execute command
  - emit events
  - flush pending local output on orderly shutdown

5. Remove process-state-file discovery as a lifecycle source of truth.

- Delete managed host/docker env-agent state-file discovery and reuse logic from `packages/environment`.
- Replace it with daemon-owned launch handles or connection registration that exists only for the lifetime of the active daemon process.
- The environment package should expose operations like:
  - `prepareWorkspace(...)`
  - `startAgent(...)`
  - `stopAgent(...)`
  - `destroyWorkspace(...)`
- The environment package should not decide whether an existing process is canonical based on PID files plus HTTP health checks.

6. Treat agent loss as worker loss, not as a session-rebind problem.

- On broken connection or dead agent:
  - mark the live worker lost in daemon memory
  - fail or retry active work according to explicit daemon policy
  - do not attempt to preserve hidden lifecycle state by rebinding the old command queue to a new session
- Make retry rules explicit:
  - operations not yet started may be retried
  - idempotent resume operations may be retried if provider semantics support it
  - active non-idempotent operations should fail visibly unless a provider-specific resume contract exists

7. Make daemon persistence the only durable truth for lifecycle and thread progress.

- Keep durable daemon-side persistence for:
  - thread state
  - event history
  - queued follow-ups
  - active operation metadata
  - provider-thread identity if it is part of the resumable product model
- Remove or sharply reduce daemon DB state that only exists to model agent transport choreography.
- Do not model the env-agent as a durable peer unless you are also willing to implement real crash-durable local agent storage.

8. Choose honesty over pseudo-reliability for agent-local state.

- Stop designing around an “agent durable outbox” unless you actually implement one on disk.
- For the disposable-worker model, agent-local buffers are explicitly ephemeral.
- If the agent dies before flushing some events, the daemon must recover from persisted thread/provider state, not from imagined transport durability.
- Document this as an intentional product tradeoff.

9. Rebuild daemon/environment boundaries around startup and teardown primitives.

- Refactor `EnvironmentService` so it no longer needs to:
  - discover agent targets from managed state files
  - retry `prepare()` to recover target disappearance races
  - hold runtime/session assumptions beyond “workspace exists and worker was started”
- Refactor orchestrator code so “ensure access” becomes a direct daemon-owned state transition instead of a composite of environment restore plus session polling.
- Refactor thread lifecycle semantics so env-agent liveness is required only after daemon-owned preparation has finished.
- Use this persisted status split:
  - `provisioning`: daemon is preparing environment/workspace state
  - `provisioned`: environment is ready; env-agent/bootstrap is expected next
  - `active`: provider work is in progress and a live env-agent is required

10. Rewrite the test strategy around behavioral guarantees.

- Delete or replace tests that assert:
  - helper call counts
  - exact poll timing
  - internal sequencing between dispatcher, session service, and environment service
- Keep a scenario matrix that proves:
  - new thread boot works
  - follow-up on idle thread starts worker on demand
  - daemon restart can resume thread work from persisted state
  - worker death while idle is harmless
  - worker death during queued work leads to explicit retry or failure according to policy
  - worker death during active work yields deterministic product behavior
  - local, worktree, and docker environments all satisfy the same lifecycle contract
  - daemon-owned preparation failure is distinct from env-agent/bootstrap failure

11. Remove superseded transport/session code aggressively rather than preserving it indefinitely.

- Delete:
  - env-agent self-suspend supervisor logic
  - command rebinding across sessions
  - managed process discovery JSON records
  - duplicate ensure/reconnect paths
  - protocol/documentation language that assumes a durable agent outbox without implementation
- Prefer a short, disruptive migration over carrying two lifecycle systems in parallel.

12. Land the redesign in phases that keep the system runnable but do not freeze the old model in place.

- Phase 1: document target ownership and add the new daemon-owned execution path
- Phase 2: switch one environment implementation to the new launcher contract
- Phase 3: remove self-suspend and session rebinding
- Phase 4: delete managed process state-file discovery
- Phase 5: simplify DB/session structures and remove no-longer-needed codepaths
- Phase 6: prune old tests and replace them with scenario coverage

# Validation

- Architecture docs describe exactly one lifecycle coordinator and no contradictory ownership language remains.
- Starting a follow-up on an idle thread launches a worker on demand without relying on stale runtime/session memory.
- Killing an env-agent process while a thread is idle does not require repair work; the next command starts a fresh worker cleanly.
- Killing an env-agent process during active work produces one explicit, deterministic outcome defined by daemon policy.
- Daemon restart recovery succeeds using persisted thread state and explicit provider resume logic, not hidden worker-local transport state.
- The same lifecycle test matrix passes for `local`, `worktree`, and `docker`.
- Obsolete codepaths and tests are deleted, not merely bypassed.

# Open Questions/Risks

- The biggest product decision is how to handle active in-flight provider work when the worker disappears. That needs an explicit user-visible policy, not implicit recovery.
- The main model choice here is already made: `provisioned` is persisted. The remaining work is making sure routes, UI copy, and lifecycle transitions all use it consistently.
- If provider resume semantics are weak or inconsistent, the daemon may need to fail active operations more often than the current design hopes.
- Removing state-file-based process discovery may require a cleaner daemon-owned worker registry for the current process lifetime.
- A single live stream is the right shape, but the specific transport choice still matters. WebSocket is likely simplest, but local HTTP streaming or pipes may also fit.
- If you later truly need remote/offline-capable agents with durable replay, that should be a separate architecture with real local persistence, not a continuation of the current hybrid model.
