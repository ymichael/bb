# Goal

Define a concrete lifecycle specification for daemon restart, env-agent reconnect, opportunistic buffered event flush, strict fencing, and zombie prevention.

This spec assumes:

- the daemon database is the only durable source of truth
- env-agent buffered events are best-effort and explicitly non-authoritative
- reconnecting a surviving env-agent after daemon downtime is an optimization, not a correctness requirement
- env-agents must not survive indefinitely without daemon contact
- daemon-owned environment preparation is distinct from env-agent-dependent provider bootstrap/execution
- `provisioned` is a persisted thread status between `provisioning` and `active`

# Scope

In scope:

- daemon restart and relaunch behavior
- env-agent behavior while daemon is unavailable
- reconnect-and-flush flow for surviving env-agents
- fencing rules for late or replaced env-agents
- nudge behavior after daemon restart
- disconnected lifetime and zombie cleanup policy
- thread reconciliation rules after forced daemon restart

Out of scope:

- provider-specific resume semantics beyond the lifecycle hooks they require
- UI copy and UX details for restart interruption messaging
- transport implementation choice beyond the behavior it must support

# Implementation Steps

1. Define the authoritative ownership model.

- The daemon DB is the only durable source of truth for:
  - thread state
  - event history already applied
  - last durable event cursor per thread
  - queued follow-ups and daemon-owned operations
  - accepted env-agent instance identity for any live thread
- The env-agent may hold ephemeral buffered outbound events/results while disconnected.
- Buffered env-agent state is not required for correctness.
- Environment preparation remains daemon-owned.
- Env-agent liveness is required only for env-agent-dependent phases.

2. Define the env-agent runtime states.

- `connected`
  - agent has an accepted live connection to the daemon
- `disconnected_buffering`
  - daemon is unreachable
  - agent keeps provider/runtime alive
  - agent may buffer events/results in memory
- `expired`
  - disconnected lifetime exceeded
  - agent is no longer eligible to reconnect as the canonical worker
- `shutting_down`
  - agent is draining or exiting after expiration or daemon instruction

2a. Define thread lifecycle semantics precisely.

- `provisioning`
  - daemon is preparing environment/workspace state
  - env-agent liveness is not implied by status alone
- `provisioned`
  - environment/workspace is ready
  - provider bootstrap is next
  - a live env-agent is expected
- `active`
  - provider work is in progress
  - a live env-agent is expected
- `idle`
  - no live env-agent is expected
- `error`
  - active work lost its required env-agent or failed at runtime
- `provisioning_failed`
  - daemon-owned preparation failed, or provider bootstrap failed before the thread became active

3. Persist minimal daemon-side live-worker metadata.

- For each thread that may still have a surviving worker, daemon should persist enough metadata to attempt restart recovery:
  - `threadId`
  - `agentId`
  - `agentInstanceId`
  - accepted `generation`
  - last known control endpoint
  - optional kill handle such as pid or container id when identity can be trusted
  - last known heartbeat timestamp
- This metadata is restart recovery aid only.
- It is not authoritative over thread progress.
- It only needs to exist for phases that actually expect a live env-agent.

4. Define daemon unavailability behavior.

- When daemon connectivity is lost, env-agent enters `disconnected_buffering`.
- In that state the env-agent:
  - keeps the provider/runtime alive
  - buffers outbound provider events and command results best-effort
  - retries reconnect with backoff
  - does not assume buffered events are committed
  - does not make thread lifecycle decisions
- If the env-agent exits before reconnect, buffered events are lost and the system remains correct.

5. Define reconnect-and-flush.

- If the same env-agent survives daemon downtime, it may reconnect and flush buffered events.
- Reconnect request must include at least:
  - `threadId`
  - `agentId`
  - `agentInstanceId`
  - `generation`
  - last agent-observed daemon-acked cursor
  - current local highest buffered sequence
- Daemon validates the reconnect against the accepted worker identity for that thread.
- If accepted, daemon replies with:
  - accepted `generation`
  - durable apply-from cursor
  - any instruction to continue normal operation
- Env-agent then sends buffered events strictly after the durable cursor.
- Daemon applies events idempotently and advances durable cursor only after successful apply.

6. Define strict fencing.

- Per thread, daemon tracks the accepted canonical worker identity:
  - accepted `agentInstanceId`
  - accepted `generation`
- Daemon must reject reconnects and event batches from:
  - unknown agent instance
  - replaced agent instance
  - older generation
  - sequence at or below durable cursor
- Once daemon accepts a replacement worker for a thread, all older workers for that thread are fenced permanently.
- Fenced workers may continue to exist at the OS level temporarily, but they must have no ability to affect daemon state.

7. Define daemon restart behavior.

- On restart, daemon rebuilds all correctness-critical state from DB only.
- Daemon does not change durable thread status just because it restarted.
- `active` remains `active`.
- `provisioning` remains `provisioning`.
- `provisioned` remains `provisioned`.
- Restart only resets operational liveness expectations, not product state.

8. Define restart nudge behavior.

- After startup, daemon identifies threads that were in env-agent-dependent phases before shutdown.
- Daemon sends a best-effort `reconnect_now` nudge to each last-known control endpoint.
- The nudge is advisory only.
- On receiving the nudge, env-agent should reset reconnect backoff and retry heartbeat/session check-in immediately with bounded jitter.
- Suggested jitter:
  - random delay between `0ms` and `1000ms`
- Purpose:
  - bypass long reconnect backoff
  - avoid thundering herd reconnects

9. Define unified heartbeat and liveness rules.

- Env-agent sends heartbeat/check-in on a regular cadence.
- If heartbeat delivery fails, env-agent retries with backoff.
- On daemon restart:
  - daemon nudges known env-agents from env-agent-dependent phases
  - daemon resets liveness baseline for those threads to daemon start time
  - env-agent resets reconnect backoff and retries immediately with jitter
- A worker is treated as alive only if the daemon observes heartbeat/check-in before the liveness timeout.
- Suggested initial values:
  - heartbeat interval: `10s`
  - liveness timeout: `30s`

10. Define replacement and dead-worker rules.

- A worker is treated as dead when any of the following is true:
  - liveness timeout expires without heartbeat/check-in
  - nudge fails and daemon has strong evidence the instance is unreachable
  - env-agent reports its own expiration
  - daemon starts and accepts a replacement worker for the same thread
- If a strong identity-backed kill handle exists for the same `agentInstanceId`, daemon may best-effort kill the stale worker.
- If identity is uncertain, daemon must not kill speculatively.
- In uncertain cases, daemon should fence and ignore instead of risking killing the wrong process.

11. Define env-agent zombie prevention.

- Env-agent should enforce a maximum disconnected lifetime.
- Suggested initial value:
  - `10 minutes`
- Behavior:
  - while disconnected, agent may buffer and retry reconnect
  - once disconnected lifetime exceeds the limit, agent transitions to `expired`
  - expired agent shuts down and abandons any ephemeral buffered data
- This TTL is local resource hygiene, not product lifecycle authority.
- Connected active agents should not be killed by a short absolute wall-clock max age.

12. Define optional daemon-driven cleanup.

- Daemon may also run cleanup on startup and periodically:
  - kill fenced stale workers when identity is strong
  - forget stale live-worker metadata after expiration horizon
  - emit diagnostics for repeated stale-worker cleanup failures
- This cleanup must not be required for correctness.

13. Define status consequences of worker loss.

- `active` + worker lost past liveness timeout -> `error`
- `provisioned` + worker lost past liveness timeout -> `provisioning_failed` until provider bootstrap can be retried
- `provisioning` during daemon-owned environment preparation -> no env-agent liveness implication
- `idle` -> no worker liveness expectation

14. Define follow-up behavior after worker loss or restart.

- If a thread later enters `error` because its env-agent died, a follow-up should:
  - restore or ensure workspace
  - start a fresh accepted worker if none is connected
  - continue through the explicit daemon-owned retry/recovery path
- If a thread is `provisioning_failed`, the next retry should restart provisioning from the appropriate phase.
- Follow-up success must not depend on whether the old worker survived daemon restart.

15. Define observable product guarantees.

- Daemon restart never leaves correctness dependent on hidden env-agent memory.
- Surviving env-agents can reduce interruption by reconnecting and flushing buffered events.
- Failure of reconnect-and-flush only loses uncommitted best-effort buffered data.
- Old or duplicate env-agents cannot corrupt thread state after replacement.
- Env-agents do not accumulate indefinitely after daemon outages.

# Validation

- Restarting the daemon while an env-agent survives allows that agent to reconnect within the grace window and flush buffered events.
- If the env-agent does not check in before the liveness timeout after daemon startup, the daemon marks the thread according to normal worker-loss rules.
- Starting a replacement worker fences any older worker permanently.
- Late reconnect attempts from fenced workers are rejected and do not alter thread state.
- A disconnected env-agent exits after the configured max disconnected lifetime.
- Best-effort nudge on daemon startup reduces reconnect latency without being required for correctness.
- Forced daemon restart does not itself change durable thread status.

# Open Questions/Risks

- `provisioned` is now part of the persisted status model, so the main risk is inconsistent adoption across routes, tests, and UI assumptions.
- The transport needs a reliable control endpoint for restart nudges; if that endpoint is unavailable during certain failures, nudge benefit drops but correctness remains intact.
- Persisting last-known worker metadata must be done carefully so it aids recovery without being mistaken for thread truth.
- If heartbeat/liveness values are too aggressive, false worker-death detection will rise. If too lax, recovery will feel sluggish.
- If disconnected TTL is too long, zombie risk increases. If too short, brief deploys may interrupt useful surviving workers.
