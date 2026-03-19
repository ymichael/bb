# Goal

Get the shared-environment, multi-thread, multi-provider architecture into a coherent and enforceable state across server, env-daemon, environment lifecycle, and QA. The target state is:

- one env-daemon per environment
- many threads per environment
- each thread owns exactly one provider session and provider thread identity
- no routing fallback may ever send work, events, or tool-call responses to the wrong thread or provider
- managed vs unmanaged environments have explicit lifecycle behavior
- environment identity is always derived from `environmentId`, never from a special thread

# Scope

In scope:

- server orchestration and environment lifecycle in `apps/server/src/orchestrator.ts`, `apps/server/src/environment-service.ts`, `apps/server/src/environment-daemon-session-service.ts`, `apps/server/src/environment-daemon-session-manager.ts`, `apps/server/src/environment-provisioning-systems.ts`, `apps/server/src/env-factory.ts`
- env-daemon runtime and session sync in `packages/environment-daemon/src/runtime.ts`, `packages/environment-daemon/src/service.ts`, `packages/environment-daemon/src/session-supervisor.ts`, `packages/environment-daemon/src/session-sync.ts`, `packages/environment-daemon/src/session-protocol.ts`
- managed environment-daemon launch/reuse code in `packages/environment/src/host-environment-daemon.ts`, `packages/environment/src/docker-environment-daemon.ts`, and worktree/local environment implementations
- automated QA and e2e coverage under `apps/server/src/__tests__/e2e/**`, `apps/server/src/__tests__/**`, and `qa/server/**`

Out of scope unless directly required by the refactor:

- app UI polish
- provider feature expansion beyond fixing correctness for `codex`, `claude-code`, and `pi`
- generated code under `packages/core/src/generated/**`

# Implementation Steps

1. Define and document hard invariants before changing behavior.

- Add a short architecture/invariants doc for environment-scoped runtime ownership and strict routing.
- Codify these rules in code comments and helper names:
  - environment is the runtime ownership boundary
  - thread is the command/event/provider-session boundary
  - provider child is the process boundary inside one env-daemon
  - no implicit “owner”, “originating”, or “representative” thread semantics
- Use this as the acceptance bar for all follow-on refactors.

2. Remove single-thread vocabulary and APIs from shared-environment code paths.

- Replace environment-runtime fields such as `ownerThreadId` in [environment-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-service.ts) with environment-scoped identity.
- Eliminate helper signatures that require a `fallbackThreadId` just to operate on an environment runtime. Existing examples:
  - `getThreadIdsForRuntimeScopeKey(scopeKey, fallbackThreadId)`
  - `clearPersistedEnvironmentStateForRuntimeScope(scopeKey, fallbackThreadId)`
- Rename variables and helpers that still imply a privileged thread for the environment runtime.
- Audit env-daemon startup/service options that still assume a single `threadId` at process scope. Existing examples:
  - `EnvironmentDaemonServiceOptions.runtime.threadId`
  - `EnvironmentDaemonSessionSupervisorOptions.threadId`
  - log/session bootstrap paths in [service.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/service.ts)

3. Refactor the env-daemon runtime to be explicitly environment-scoped and thread-routed.

- Remove the remaining mutable “active child” model in [runtime.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/runtime.ts). `providerChild` should stop being a routing fallback for thread-bound commands.
- Make thread and provider-child routing explicit and total:
  - every thread-bound command must resolve a live child from thread ownership state
  - every provider-initiated request/response must carry enough identity to route back to the correct thread and child
  - missing routing state must fail loudly with typed errors instead of using shared mutable defaults
- Convert `threadIdToChild`, `threadIdToProviderId`, and `threadIdByProviderThreadKey` into a single coherent routing model keyed by explicit thread and provider-thread identity.
- Remove or isolate behaviors that are only valid for legacy single-provider mode, especially:
  - `mapped ?? this.providerChild ?? this.ensureProviderRunning()`
  - `args.child ?? this.providerChild`
  - provider-id fallback to process-wide defaults when thread-specific state should exist
- Make provider initialization state child-scoped and validated by spec/child identity only.

4. Rework session sync/supervision around environment channels instead of a primary thread.

- [session-supervisor.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/session-supervisor.ts) still starts from one `threadId` and opens the session with a single bootstrap channel. Replace that with an environment-scoped supervisor that owns a set of attached channels.
- [session-sync.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/session-sync.ts) currently derives session identity from `threadIds[0]`. Replace this with explicit session identity and channel collection; no `threadIds[0]` lookups should remain.
- Make channel attach/detach part of the durable control flow:
  - open session with all known attached channels
- lazily add threads/providers as work arrives in the environment
- tear down thread-local provider state when that thread becomes idle, when safe
- remove archived/detached threads explicitly
- shut down the env-daemon when the environment has no active work and no queued work
- Preserve the current strict behavior in [environment-daemon-session-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-daemon-session-service.ts) where invalid `channelId` is rejected; expand that strictness across all client/runtime layers.

5. Remove thread selection fallbacks from server orchestration and capability queries.

- Audit and remove all `[0]`, `.find(...)`, or “first attached thread” selection in environment-scoped paths where the operation should be explicit or environment-scoped.
- Existing hotspots to fix:
  - `requestEnvironmentOperation()` in [orchestrator.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/orchestrator.ts) selecting the first matching thread for promote/demote
  - `_listProviderModelsFromEnvironmentDaemon()` and `_listProviderCatalogFromEnvironmentDaemon()` choosing a representative thread from attachments
  - primary checkout demotion paths in [environment-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-service.ts) falling back from persisted promoted thread to any thread attached to the environment
- Where an operation is truly environment-scoped, route it by environment/session directly.
- Where an operation is thread-scoped, require the caller to supply the thread and reject ambiguity.

6. Make provider discovery and model listing environment-scoped, not thread-piggybacked.

- Treat provider runtime information as environment-local, not server-authoritative. Different environments may expose different providers/models/capabilities and the server may not live on the same host.
- `provider.list_catalog` should query the env-daemon for a specific `environmentId` and return providers actually available in that environment.
- `provider.list_models` should query the env-daemon for `(environmentId, providerId)`.
- The server may still expose static built-in adapter metadata, but that must remain clearly separate from runtime availability/capability answers.
- Remove all “representative thread” routing for provider queries. These queries must route by explicit environment identity, and by explicit provider identity when needed.
- If no env-daemon is available for the target environment, either:
  - start/recover it explicitly for that environment query, or
  - fail clearly with an environment-runtime-unavailable error
- Never answer runtime provider queries from the server process alone.

7. Harden environment lifecycle around managed vs unmanaged environments.

- Make `managed` the sole switch for setup/cleanup behavior. Do not infer cleanup behavior from thread history or sibling presence alone.
- Review [environment-provisioning-systems.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-provisioning-systems.ts), [env-factory.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/env-factory.ts), and [environment-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-service.ts) for thread-derived environment state.
- Ensure worktree/docker artifact creation and cleanup are keyed by `environmentId` and persisted environment record, not by whichever thread happened to create or resume first.
- Review managed env-daemon caches in:
  - [host-environment-daemon.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment/src/host-environment-daemon.ts)
  - [docker-environment-daemon.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment/src/docker-environment-daemon.ts)
- Those files already key reuse by project/environment/workspace identity, but they still persist `threadId` in records and public APIs. Remove any remaining behavior where that thread id is treated as runtime ownership instead of incidental metadata.
- Do not preserve legacy thread-shaped managed artifact identity. Old managed worktree/docker data can be deleted and reprovisioned. Build the new layout around `environmentId` only.

8. Enforce strict routing and error semantics at the type boundary.

- Introduce small typed helpers for the key internal identities:
  - `EnvironmentId`
  - `ThreadId`
  - `ProviderId`
  - `ProviderThreadId`
  - `EnvironmentChannelId` if you want channel to remain distinct from thread terminology
- Add explicit lookup helpers that return `Result`-style success/failure or throw domain errors when:
  - thread is not attached to the environment
  - provider id does not match the thread
  - provider thread id cannot be resolved uniquely
  - no provider child owns the thread
- Replace permissive internal fallbacks with exhaustive switches and explicit error codes. This is a `closed_internal` domain and should not tolerate unknown/ambiguous values.

9. Consolidate notification and provider-request resolution to one canonical path.

- Keep the existing strict `channelId` requirement in env-daemon provider requests and make it the only valid path.
- Review `_resolveNotificationThreadId()` in [orchestrator.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/orchestrator.ts) and make “cannot map provider event to exactly one thread” a surfaced error path, not a silent return of the current thread.
- Ensure all provider event envelopes include enough internal metadata to unambiguously map back to the thread. If that metadata is missing, emit a clear internal error event and fail the turn instead of hanging.

10. Rebuild the automated test matrix around the real failure modes.

- Add unit/integration coverage for “must throw, never fallback” cases:
  - command routed for unattached thread
  - provider request with missing/wrong `channelId`
  - provider event with ambiguous or mismatched provider-thread identity
  - environment-scoped command attempted without explicit thread when required
- Expand env-daemon runtime tests in [runtime.test.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/runtime.test.ts) to cover:
  - two providers, same environment, interleaved resume + follow-up + stop
  - one child exit must not poison sibling child requests
  - provider request/response routing under simultaneous tool calls from different providers
- Add session-sync/supervisor tests for multi-channel operation. Current tests are still mostly single-channel.
- Add server e2e scenarios that currently do not exist:
  - two different providers in the same shared environment
  - archive one sibling while the other keeps running in the same env-daemon
  - resume after env cleanup when multiple threads still reference the environment record
  - managed vs unmanaged shared environment lifecycle
- Keep fake-provider deterministic recovery tests, but add real-provider smoke for the shared multi-provider scenario because this class of bug has already escaped single-provider coverage.

11. Promote the manual QA matrix into required automated and human-gated checks.

- Treat the restart and relaunch checks in [standalone-workflow.md](/Users/michael/.codex/worktrees/4b0b/bb/qa/shared/standalone-workflow.md) as a release gate for env-daemon/runtime/provider-routing changes.
- Add a checked-in automated scenario for that matrix, then reduce the manual pass to a shorter confirmation run.
- Update `qa/README.md` and server package scripts so “shared env + multi-provider coexistence” is an explicit tier, not a note buried in documentation.

12. Execute the refactor in slices that preserve correctness.

- Slice A: invariants + naming cleanup + strict error helpers
- Slice B: env-daemon runtime routing refactor
- Slice C: session supervisor/sync multi-channel refactor
- Slice D: environment-scoped provider query refactor
- Slice E: server orchestration/environment lifecycle cleanup
- Slice F: automated QA expansion + manual regression pass
- Do not mix broad renames with behavior changes unless the tests for that slice land first.

# Validation

- Typecheck targeted packages after each slice:
  - `pnpm exec turbo run typecheck --filter=@bb/environment-daemon`
  - `pnpm exec turbo run typecheck --filter=@bb/environment`
  - `pnpm exec turbo run typecheck --filter=@bb/provider-adapters`
  - `pnpm exec turbo run typecheck --filter=@bb/server`
- Run focused unit/integration suites for:
  - env-daemon runtime
  - session sync/supervisor
  - environment service
  - orchestrator
- Add and run e2e coverage for:
  - shared environment multi-thread same provider
  - shared environment multi-thread mixed providers
  - archive/unarchive sibling behavior
  - restart/recovery with shared environment
  - managed environment cleanup vs unmanaged preservation
- Run the checked-in manual server QA matrix for:
  - multi-provider coexistence
  - provider-initiated tool calls through session-backed env-daemon
  - shared environment lifecycle and restart recovery
- Acceptance criteria:
  - no internal routing fallback remains for thread/provider/environment identity
  - any ambiguity becomes an explicit error with enough detail to debug
  - two providers can coexist in one env-daemon without cross-thread contamination
  - archive/unarchive/resume behave correctly for shared managed and unmanaged environments
  - provider catalog/model queries are environment-scoped and never routed through an arbitrary attached thread

# Remaining Checklist

1. Finish removing `threads.environmentId` as live runtime authority when attachments exist.

- Audit [apps/server/src/environment-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-service.ts) for methods that still fall back to `threadRepo.getById(threadId)?.environmentId` in operational paths.
- Audit [apps/server/src/orchestrator.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/orchestrator.ts) for the remaining write/read paths that still treat thread-row `environmentId` as operational state instead of compatibility residue.
- Keep the rule strict:
  - if attachments exist, attachment rows are authoritative
  - stale thread-row `environmentId` must not influence routing, lifecycle, cleanup, or capability answers

2. Tighten `EnvironmentService` behavior to fail closed on missing/ambiguous attachment state.

- Remove helper behavior that treats “missing attachment” as “maybe still attached via thread row”.
- Review cleanup, suspend, destroy, archive, and primary-checkout helpers for representative-thread or thread-row fallbacks.
- Where attachment state is missing for an environment-scoped operation, return unattached/not-found semantics instead of guessing.

3. Sweep environment lifecycle transitions end-to-end for shared-environment correctness.

- Re-verify:
  - suspend
  - resume
  - archive
  - unarchive
  - reprovision after cleanup
  - sibling detach / last attached thread detach
- Ensure every one of those flows is keyed by `environmentId` and attachment membership, not by whichever thread happened to provision or resume first.

4. Re-audit env-daemon session/runtime recovery for hidden single-thread assumptions.

- Review [apps/server/src/environment-daemon-session-service.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-daemon-session-service.ts), [apps/server/src/environment-daemon-session-manager.ts](/Users/michael/.codex/worktrees/299a/bb/apps/server/src/environment-daemon-session-manager.ts), and [packages/environment-daemon/src/runtime.ts](/Users/michael/.codex/worktrees/299a/bb/packages/environment-daemon/src/runtime.ts).
- Specifically check reconnect, invalidation, session replacement, allowed-channel enforcement, and notification routing for:
  - same provider across multiple threads in one environment
  - multiple providers in one environment
  - stale old-session noise after replacement

5. Fill the remaining regression gaps before calling the refactor complete.

- Add or extend automated coverage for:
  - same provider, multiple threads, one environment
  - mixed providers, one environment, archive/resume/restart transitions
  - missing/stale attachments failing closed
  - ambiguous provider-thread identity or notification routing
  - managed vs unmanaged shared-environment lifecycle differences

6. Run the full server/env-daemon QA gate at the end, not just targeted suites.

- Required automated pass:
  - `pnpm --filter @bb/server test:e2e:smoke`
  - `pnpm --filter @bb/server test:e2e:qa:regression`
  - `pnpm --filter @bb/server test:e2e:qa:multi-provider` with real provider credentials
  - `pnpm --filter @bb/server test:e2e:qa:stress`
- Required final invariant sweep:
  - grep for representative-thread / first-thread fallback patterns
  - grep for new writes of `threads.environmentId` in attached-environment flows
  - confirm no silent routing fallback remains for provider/thread/environment identity

# Open Questions/Risks

- Env-daemon should be environment-scoped, but thread/provider activation inside it should be lazy. The remaining work is making sure the implementation does not preserve a “special bootstrap thread” concept while doing that.
- Provider catalog/model queries should be environment-scoped runtime queries, not thread-piggybacked and not server-authoritative.
- Worktree/docker managed artifacts should move directly to environment-shaped identity. Old managed data can be deleted instead of migrated, which simplifies the refactor and reduces compatibility branches.
- This refactor should be staged, but it is not a “small patches” problem. Touching only one layer will keep producing phantom routing bugs because the single-thread assumptions currently span server, env-daemon, and environment-launch code together.
