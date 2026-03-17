# Env-Daemon Provider Boundary Plan

## Goal

Shift provider-specific runtime ownership out of the server and into `@bb/environment-daemon`, so the server speaks one BB-specific, provider-agnostic protocol to env-daemons. The end state should let old and new managed environments continue to work across provider/runtime upgrades as long as their env-daemon can still negotiate and satisfy the BB protocol.

Treat future cross-machine deployment as a hard design constraint now: the server and env-daemon must be able to run on different machines with independent versioning, restart behavior, and network reachability.

## Scope

### What changes

- Re-draw the control-plane boundary between:
  - `apps/server` orchestrator and session services
  - `packages/provider-adapters`
  - `packages/environment-daemon`
- Define a BB-native env-daemon command/event protocol with explicit capability and version negotiation.
- Treat the server <-> env-daemon seam as a real network boundary rather than a same-machine implementation detail.
- Move provider command construction, provider event normalization, and provider compatibility logic into env-daemon.
- Introduce an env-daemon compatibility strategy for:
  - BB protocol version skew
  - provider adapter version skew
  - provider CLI/SDK/runtime version skew
- Update managed environment startup/recovery so the server can decide when to reuse, degrade, or replace an env-daemon.
- Add automated coverage for mixed-version and mixed-provider scenarios.

### What stays

- The server remains the durable source of truth for projects, threads, events, queues, and recovery policy.
- SQLite remains the source of durable state for session metadata, commands, results, and thread history.
- Environment implementations in `@bb/environment` still own where the env-daemon runs and how it is launched.
- Web app and CLI continue to talk only to the server.
- The server can continue to expose provider catalogs and project/thread APIs; the change is about who owns provider execution semantics.

### Out of scope

- Replacing the current environment model (`local`, `worktree`, `docker`).
- Redesigning manager threads or project/thread UX.
- Full cross-machine remote execution productization. The protocol and ownership model should be designed for it now, but this plan does not include building remote scheduling, auth, or fleet management.
- Making old env-daemons support arbitrary future BB features forever; the plan should define bounded compatibility, not infinite compatibility.

## Implementation Steps

### Phase 1: Define the architectural target explicitly

1. Document the new ownership split:
   - **Server** owns durable orchestration, queueing, lifecycle, recovery decisions, projections, and user-facing APIs.
   - **Env-daemon** owns provider adapter selection, provider process lifecycle, provider thread/session lifecycle, provider event normalization, and provider-version compatibility handling.
   - **Environment implementations** own env-daemon placement, launch, upgrade/replacement, and runtime reachability.
   - **Server <-> env-daemon** communication must remain valid across machine boundaries with no reliance on shared process state or shared filesystem access.

2. Define the new package roles:
   - `packages/environment-daemon`: smart per-thread worker runtime and BB protocol endpoint.
   - `packages/provider-adapters`: shared built-in provider adapters and helper modules consumed by env-daemon and other provider-aware code.

3. Update `ARCHITECTURE.md` after the design is settled so the docs reflect the new boundary rather than the current mixed model.

### Phase 2: Define a BB-native server <-> env-daemon protocol

1. Replace the current implicit middle-layer semantics with an explicit BB protocol contract.

2. Keep the current command names only if they are redefined as BB-owned semantics. A workable first pass is:
   - `provider.ensure`: ensure the env-daemon runtime for this BB thread is ready to accept BB commands
   - `thread.start`: ensure backing provider state exists for this BB thread
   - `thread.resume`: rebind this BB thread to previously known backing state if possible
   - `turn.start`: process new user input for this BB thread
   - `turn.steer`: add input to the active BB turn if supported

3. Remove provider-specific payload assumptions from the server-side meaning of those commands:
   - the server should not know provider RPC methods
   - the server should not know provider request/response envelope shapes
   - the server should not decide provider-specific fallback rules like whether a follow-up must map to steer vs start

4. Define BB-native result and event categories returned by env-daemon, for example:
   - runtime readiness
   - provider-backed thread created/resumed/missing
   - turn started/completed/interrupted/failed
   - title updated
   - tool call requested / tool call result applied
   - auth required / auth refresh failed
   - provider unavailable / provider incompatible / env-daemon incompatible

5. Keep the session transport narrow:
   - session open/welcome
   - heartbeat
   - command batch
   - command ack/result
   - event batch
   - session replaced/closed

6. Design protocol payloads and semantics so they survive remote deployment:
   - no assumptions that server-visible paths are valid on the env-daemon host
   - no reliance on local process identity outside the env-daemon machine
   - explicit reconnect/session replacement behavior after network partitions

### Phase 3: Add explicit capability and version negotiation

1. Expand session open negotiation beyond a single protocol version integer.

2. Have env-daemon advertise:
   - supported BB protocol versions
   - env-daemon build/version
   - supported command set
   - optional command features/capabilities
   - supported provider ids
   - provider adapter versions bundled into that env-daemon

3. Have the server respond with:
   - selected BB protocol version
   - required capabilities for this thread
   - optional capabilities the server may use if present
   - minimum compatibility requirements for the requested provider

4. Add a compatibility matrix in code, not just docs:
   - server BB protocol version range
   - env-daemon BB protocol version range
   - provider adapter compatibility range
   - provider runtime/CLI version constraints when detectable
   - remote deployment assumptions that must hold regardless of whether server and env-daemon share a host

5. Make negotiation failure explicit and recoverable:
   - `bb_protocol_incompatible`
   - `provider_adapter_missing`
   - `provider_adapter_incompatible`
   - `provider_runtime_unsupported`
   - `env_daemon_unreachable` / `session_replaced` recovery paths that are normal operational cases rather than fatal edge cases

### Phase 4: Version the provider adapters inside env-daemon

1. Treat each provider adapter as a versioned component with a stable internal interface inside env-daemon.

2. Define adapter metadata per provider:
   - adapter id (`codex`, `claude-code`, `pi`)
   - adapter implementation version
   - supported provider CLI/SDK version range
   - supported BB command features
   - known degradation behavior

3. On env-daemon startup, detect and record the actual provider runtime version when possible:
   - CLI version
   - SDK package version
   - protocol/schema version if the provider exposes one

4. Persist enough compatibility metadata to explain failures later:
   - env-daemon build/version
   - selected BB protocol version
   - provider id
   - adapter version
   - detected provider runtime version

5. Keep provider compatibility decisions local to env-daemon:
   - if a provider runtime is newer but still within adapter tolerance, env-daemon adapts without server changes
   - if a provider runtime is unsupported, env-daemon returns a BB-native compatibility error and the server decides how to present or recover

### Phase 5: Migrate provider semantics out of server-owned helper layers

1. Move these responsibilities from the old server-side provider layer into env-daemon-owned provider adapters:
   - provider command creation
   - provider initialize params
   - thread start/resume payload construction
   - turn start vs steer execution choice
   - provider event normalization into BB-native events
   - provider-specific stderr/auth handling
   - provider tool-call request decoding and response encoding

2. Keep only one owner for each semantic decision. In particular, avoid a half-migrated state where:
   - the server still interprets provider event methods
   - env-daemon also interprets them
   - both sides know provider thread id semantics

3. During migration, the server may temporarily support two paths:
   - legacy provider-aware command path for old env-daemons
   - new BB-native path for upgraded env-daemons

4. Gate that dual path on negotiated capabilities and remove the legacy path once old env-daemons are no longer supported.

### Phase 6: Add env-daemon upgrade and replacement policy

1. Define what counts as an env-daemon identity:
   - env-daemon build/version
   - bundled provider adapter versions
   - selected provider id
   - BB protocol compatibility range

2. On thread/environment restore, compare the active or persisted env-daemon identity against the server’s requirements.

3. Server policy should distinguish:
   - **reuse**: active env-daemon is compatible
   - **degrade**: active env-daemon is compatible but lacks optional features
   - **replace**: active env-daemon is incompatible or known-bad

4. For managed environments:
   - make replacement the default when incompatible
   - launch the newer env-daemon bundle and retire the old session

5. For shared/local environments:
   - support replacement where BB owns the sidecar launch
   - if replacement is impossible, surface a targeted compatibility error rather than generic provider failure

6. Add explicit recovery hooks so replacement is not treated as an exceptional path. It should be a normal branch of startup/session recovery.

7. Keep replacement semantics compatible with future remote deployment:
   - replacement may mean connecting to a newly launched env-daemon on another host, not just restarting a local sidecar
   - session identity must be decoupled from local PID/process assumptions

### Phase 7: Define compatibility guarantees for old and new environments

1. Adopt a bounded support window. Suggested initial policy:
   - server supports `N` and `N-1` BB protocol major versions
   - env-daemon supports additive minor changes within a major version
   - incompatible major changes require env-daemon replacement

2. Prefer additive evolution rules:
   - adding optional commands/events/capabilities is allowed
   - removing or reinterpreting existing command semantics requires a new major protocol version
   - required fields should be introduced only behind a version bump or capability gate

3. Define provider-adapter support policy separately from BB protocol policy:
   - a BB protocol-compatible env-daemon can still reject a provider runtime if that runtime is outside the adapter’s supported range
   - provider adapter support windows should be documented per provider

4. Preserve old managed environments by bundling enough compatibility logic in new env-daemon releases to talk to the same BB protocol and, where feasible, older persisted provider state.

### Phase 8: Persistence and observability changes

1. Extend persisted env-daemon session data to capture:
   - env-daemon version/build hash
   - negotiated BB protocol version
   - negotiated capabilities
   - provider id
   - provider adapter version
   - detected provider runtime version

2. Extend health/status endpoints to expose compatibility state for debugging:
   - protocol compatibility
   - adapter/runtime compatibility
   - replacement recommended vs required
   - env-daemon host/session identity and reachability state when relevant

3. Improve failure reporting in timelines and system health:
   - make version incompatibility distinct from generic provider startup failure
   - make “replacement required” visible in system restart/recovery recommendations

### Phase 9: Testing and rollout strategy

1. Add protocol-contract tests that validate:
   - negotiation success/failure
   - capability-gated behavior
   - old/new command compatibility
   - explicit major-version rejection

2. Add mixed-version integration tests:
   - new server with previous env-daemon bundle
   - previous server with new env-daemon bundle where supported
   - env-daemon replacement during startup recovery
   - reconnect/replacement behavior that does not assume same-machine deployment

3. Add provider-version tests per provider:
   - supported runtime version
   - newer-but-tolerated runtime version
   - unsupported runtime version

4. Expand daemon QA with compatibility scenarios:
   - start a thread, upgrade env-daemon, resume thread
   - simulate stale env-daemon bundle in a managed worktree
   - simulate provider CLI version drift
   - confirm old and new environments continue to function when compatibility rules are satisfied

5. Roll out in stages:
   - stage 1: negotiation metadata only
   - stage 2: BB-native command/event mirrors behind capability flags
   - stage 3: provider normalization moves into env-daemon
   - stage 4: remove legacy server-side provider semantics

## Validation

- [ ] Server can negotiate BB protocol version and capabilities with env-daemon on session open.
- [ ] Env-daemon exposes provider adapter version metadata and detected provider runtime version.
- [ ] New server can continue to use an older env-daemon when versions are compatible.
- [ ] New server can explicitly reject or replace an incompatible env-daemon.
- [ ] Managed environments automatically replace stale env-daemons during recovery when needed.
- [ ] `thread.start`, `thread.resume`, `turn.start`, `turn.steer`, and `provider.ensure` behave as BB-native commands without the server needing provider RPC details.
- [ ] Provider event normalization happens inside env-daemon, not in the server.
- [ ] Provider-specific auth/runtime/version errors are surfaced back as BB-native compatibility or runtime errors.
- [ ] Mixed-version e2e scenarios pass for at least one older env-daemon generation.
- [ ] Real-provider smoke/stress QA still passes after the boundary shift.

## Open Questions / Risks

1. **How far to reduce server-side provider helpers after package retirement**: The main `packages/agent-server` split is gone, but there is still a question of how much provider-aware convenience logic should remain in `apps/server` versus moving entirely behind env-daemon or `@bb/provider-adapters`.

2. **How much provider state env-daemon should durably persist locally**: The current env-daemon delivery state is in-memory. If env-daemon becomes the stronger provider owner, purely in-memory provider/session metadata may become too fragile.

3. **How old an env-daemon we really want to support**: Supporting `N-1` is tractable; supporting arbitrary historical sidecars is not.

4. **Compatibility of persisted provider thread ids across adapter versions**: Some provider upgrades may invalidate resume semantics even when the BB protocol stays compatible.

5. **Behavior drift in “steer vs start” semantics**: Once env-daemon owns that decision, the product behavior must remain consistent enough that the UI/CLI/server do not observe surprising regressions.

6. **Tool-call ownership boundary**: If provider tool-call decoding/encoding moves fully into env-daemon, the interface back to the server for dynamic tools must stay typed and narrow.

7. **Upgrade timing for shared/local environments**: Replacing env-daemons in BB-managed worktrees is straightforward; replacing sidecars attached to shared local environments may be more failure-prone and needs explicit operational rules.

8. **Same-machine assumptions hidden in current payloads**: Some current command/session fields may implicitly assume shared paths, shared host identity, or same-machine restart behavior and need to be identified early.
