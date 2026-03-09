# Goal

Remove the daemon's per-thread live `AgentServer` session model and move all thread control to stateless HTTP interactions with the environment-agent.

The end state should be:

- the environment-agent is the durable execution/control boundary
- the daemon opens short-lived HTTP clients when it needs to issue commands or query state
- thread continuity does not depend on daemon-owned in-memory session state
- loss of a daemon connection is never interpreted as proof that a thread stopped

# Scope

In scope:

- replace daemon-side `startSession`, `resumeSession`, `sendTurn`, `stopSession`, replay/status/ack/retry usage with HTTP-first control paths
- eliminate daemon-owned authoritative session state such as in-memory `providerThreadId` / `activeTurnId`
- add explicit environment-agent HTTP control endpoints for provider-thread lifecycle and turn commands
- migrate orchestrator logic, daemon routes, and restart/shutdown semantics to the HTTP-only model
- remove test harness workarounds and shift regression coverage to the new control boundary

Out of scope:

- changing the durable product/event model unless required to support HTTP-only control
- redesigning provider event schemas beyond what is necessary to support the new command flow
- changing user-facing thread semantics unrelated to daemon/session ownership

# Implementation Steps

1. Define the HTTP-only target contract.
   - Treat the environment-agent HTTP API as the only daemon-to-runtime control surface.
   - Define explicit command endpoints for:
     - `thread/start`
     - `thread/resume`
     - `thread/stop`
     - `turn/start`
     - `turn/steer`
     - thread rename / name set
   - Keep replay, ack, status, and delivery retry on the same HTTP control plane.
   - Decide which command responses must be synchronous versus “accepted, await delivered events”.

2. Move provider command execution behind explicit environment-agent HTTP endpoints.
   - Add environment-agent HTTP handlers that translate request bodies into provider runtime RPC calls.
   - Reuse existing provider runtime behavior where possible, but stop requiring the daemon to own a long-lived `ProviderRuntime`.
   - Preserve provider launch/ensure behavior inside the environment-agent.

3. Introduce daemon-side stateless environment-agent accessors.
   - Add a small daemon utility layer that:
     - restores the thread environment
     - resolves the HTTP target
     - creates a short-lived HTTP environment-agent client
     - issues the requested control call
     - closes the client
   - Use this layer for:
     - provider ensure
     - start/resume/stop
     - turn start/steer
     - rename
     - status/replay/ack/retry

4. Remove `AgentServer` authority from orchestrator control flow.
  - Replace `agentServer.startSession()` in spawn/provisioning with stateless HTTP `thread/start`.
  - Replace `agentServer.resumeSession()` with stateless HTTP `thread/resume`.
  - Replace `agentServer.sendTurn()` with stateless HTTP `turn/start` / `turn/steer`.
  - Replace `agentServer.stopSession()` / `stopAllSessions()` with stateless HTTP `thread/stop` only where explicit thread stop is intended.
  - Remove the assumption that daemon shutdown must stop provider runtime unless product semantics explicitly require it.
  - Sequencing note:
    - do not switch orchestrator command paths until live provider notifications, stderr, and replay-triggered lifecycle updates no longer depend on a managed session-backed stream attachment
    - otherwise spawn/tell will lose immediate lifecycle updates even if command RPCs succeed

5. Eliminate daemon-owned in-memory session state.
   - Remove `providerThreadId` / `activeTurnId` from `ManagedSession` as authoritative daemon state.
   - Replace read paths with durable derivation:
     - provider thread id from indexed event history
     - active turn id from latest delivered lifecycle events
   - Keep only minimal per-request local variables; no long-lived thread session map should be needed in steady state.

6. Redefine live notification handling.
  - Stop treating a daemon stream attachment as the source of truth for thread liveness.
  - Prefer delivered/buffered environment-agent events as the authoritative update path.
  - Replace current live-session responsibilities explicitly:
    - provider notification ingestion
    - stderr/auth-refresh warning handling
    - active turn tracking derived from delivered lifecycle events
  - If command calls need immediate follow-up responses, use:
    - delivered events
    - explicit status reads
     - or bounded request-scoped stream attachment only for that request
   - Do not reintroduce daemon-owned persistent subscriptions unless strictly necessary.

7. Simplify restart and shutdown semantics around the HTTP-only model.
   - Daemon shutdown should not imply provider/runtime shutdown unless the user explicitly stops a thread.
   - Remove any remaining code that maps daemon session loss to `active -> idle`.
   - Keep boot behavior narrow:
     - archived cleanup
     - active-thread delivery nudge
     - no daemon-session recovery

8. Shrink or remove `@beanbag/agent-server`.
   - After orchestrator no longer depends on long-lived managed sessions, decide whether:
     - `AgentServer` can be deleted outright, or
     - it should remain only as a provider event normalization helper with no session ownership
   - Remove dead session APIs and test infrastructure once all call sites are migrated.

9. Rewrite tests around the new boundary.
   - Replace session-oriented unit tests with HTTP command/control tests.
   - Remove daemon tests that rely on `agentServer.sessions`.
   - Strengthen e2e restart coverage so it exercises the real environment-agent HTTP path with no harness workarounds.
   - Keep regression tests for:
     - daemon restart during active turn
     - daemon shutdown while thread continues running
     - delayed delivery catch-up after daemon restart
     - explicit stop/archive semantics

10. Clean up data-flow semantics and documentation.
   - Update restart policy endpoints/docs to describe the HTTP-only model.
   - Document that `Thread.status` is a daemon-known summary derived from delivered events, not proof of current runtime liveness while the daemon is offline.
   - Document that the environment-agent is the continuity boundary.

# Validation

- Unit tests for environment-agent HTTP command endpoints:
  - start/resume/stop
  - turn start/steer
  - rename
  - replay/status/ack/retry
- Unit tests for daemon stateless accessors proving:
  - no persistent per-thread session map is required
  - commands use restored environment HTTP targets directly
- Orchestrator tests proving:
  - spawn and tell work without `agentServer.sessions`
  - restart does not mutate active threads to idle
  - transport/client closure does not imply thread exit
- E2E tests covering:
  - active turn survives daemon restart
  - daemon shutdown while environment-agent keeps running
  - buffered event catch-up after delayed daemon restart
  - explicit stop halts the thread
  - archive still destroys the environment
- Final cleanup check:
  - no daemon call sites depend on `AgentServer` managed session state for correctness

# Open Questions/Risks

- Do command endpoints return provider thread/turn identifiers synchronously, or should the daemon rely entirely on delivered events for those identities?
- Does any UI/route path still require immediate “live” turn state beyond what delivered events and status reads can provide?
- If request-scoped stream attachments are needed for certain interactive flows, keep them strictly request-scoped so they do not quietly recreate the live-session architecture.
- Removing `AgentServer` may expose normalization/event-projection utilities worth keeping separately; do not force deletion if a smaller non-session helper package is cleaner.
- Explicit stop semantics need product clarity:
  - should user stop send `thread.stop` to the environment-agent/provider, or only detach the daemon?
  - current intent suggests explicit stop should stop the thread, while daemon shutdown should not
- Migration sequencing matters:
  - half-migrated state could leave some commands session-based and others stateless, which is a riskier intermediate architecture than the current one
- The strongest acceptance criterion is behavioral:
  - daemon restart/shutdown must never be able to change thread liveness merely because daemon-owned control state disappeared
