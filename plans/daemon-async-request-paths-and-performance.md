# Goal

Remove event-loop-blocking process execution from production request and event-delivery paths, reduce redundant synchronous hydration, and make thread/workspace/timeline updates feel immediate on localhost.

The target state is:

- no `spawnSync`/`execSync` on daemon, environment, or agent-server production hot paths
- lightweight thread/detail reads that do not synchronously recompute git state inline
- async, non-blocking workspace/git reads on all hot request paths
- cached, event-driven workspace status snapshots only where freshness guarantees are explicit and strong enough to avoid stale data bugs
- incremental timeline updates instead of repeated full refetch/rebuilds
- clear instrumentation proving queueing time, handler time, and blocking time separately

# Scope

In scope:

- Production `spawnSync`/sync process usage in `apps/daemon/**`, `packages/environment/**`, and `packages/agent-server/**`
- Thread detail, work-status, operation acknowledgement, and timeline read paths
- Daemon-side instrumentation for queued vs executing request time and event-loop delay
- App request fan-out and invalidation behavior that amplifies daemon-side blocking
- Tests covering async conversions and end-to-end latency-sensitive flows

Out of scope:

- Dev/test scripts that intentionally use sync process APIs
- Generated code under `packages/core/src/generated/**`
- Broad UI redesign beyond the data-fetching and update-path changes needed for responsiveness
- Provider protocol changes unrelated to latency/blocking

# Implementation Steps

Current status:

- Done:
  - added daemon perf debug instrumentation hooks and request timing headers/logging
  - added targeted orchestrator timings for thread, work-status, timeline, operation, and execution-options reads
  - removed avoidable hydrated route lookups for `default-execution-options`, `PATCH /threads/:id`, and `GET /threads/:id/output`
  - removed the thread-detail `default-execution-options` fetch by serving that data on the thread payload
  - removed the thread-detail parent-thread network fetch in favor of cached thread-list data
  - stopped the thread-detail view from eagerly fetching merge-base work status when the base thread payload already has the same branch
  - removed the short-lived caching experiments in daemon/environment so the async migration is the primary fix path
  - converted production child-process hot paths from sync to async across daemon, environment, docker environment, and agent-server code
  - made thread detail, work-status, git diff, checkout snapshot, promote/demote, and docker container lifecycle paths prefer async environment APIs
  - changed production sync environment/git/process helpers to fail fast instead of silently blocking the event loop
  - added a repo lint guard that bans `spawnSync` / `execSync` / `execFileSync` in production TypeScript code
  - reintroduced only default-branch caching in `git-project.ts`
- In progress:
  - removing remaining synchronous filesystem work in hot paths where it is still materially observable
  - deciding the right long-term thread-detail read model (`GET /threads/:id` vs composite read endpoint)
  - defining the first safe post-async cache beyond default-branch detection

1. Confirm and instrument the blocking before broad refactors

- Add per-request metrics/log fields for:
  - request start timestamp
  - handler-enter timestamp
  - handler-complete timestamp
  - total time vs in-handler time
- Add Node event-loop delay monitoring in the daemon process.
- Add scoped timing around:
  - `ThreadManager.getById()` / `_hydrateThreadState()`
  - `getWorkStatusAsync()` / environment workspace status calls
  - `getTimeline()`
  - `requestThreadOperation()` action-resolution path
- Add explicit timing around `GET /threads/:id/default-execution-options` so we can separate the cheap execution-options lookup from the expensive hydrated existence check.
- Add a simple debug mode or structured log output that makes queueing visible without DevTools.
- Measure with awareness that React `StrictMode` can duplicate mount/fetch behavior in development, so request-count baselines should also be checked in a production build.

2. Remove avoidable route-level hydration mistakes first

- Sweep thread routes and replace `threadManager.getById(...)` existence checks with raw lookup helpers where hydration is not required.
- Prioritize the routes already identified:
  - `GET /threads/:id/default-execution-options`
  - `PATCH /threads/:id`
  - `GET /threads/:id/output`
- Keep `GET /threads/:id` as a separate redesign item rather than a mechanical swap, because its current payload shape depends on hydration.

3. Eliminate sync process execution from production hot paths (async before cache)

- Audit all production `spawnSync`/`execSync` usage and classify each call site as:
  - request path
  - background/watch path
  - startup/provisioning path
  - non-user-facing utility path
- Replace request-path sync calls with async equivalents first.
- Prioritize:
  - `packages/environment/src/process.ts`
  - `packages/environment/src/git-workspace.ts`
  - `apps/daemon/src/git-project.ts`
  - `packages/agent-server/src/codex-commit-message-generator.ts`
  - production code in `packages/environment/src/docker-environment.ts`, `local-environment.ts`, and `worktree-environment.ts`
- Keep temporary compatibility wrappers only if they are clearly marked and not used from request handlers.
- Add a lint rule or repository check to prevent new sync child-process calls in production code.
- Do not add new caching in place of async conversions unless the cache invalidation/freshness model is explicit enough to guarantee non-stale reads.

4. Split lightweight thread metadata from expensive hydrated state

- Make `GET /threads/:id` cheap and deterministic:
  - fetch DB-backed thread metadata
  - avoid inline workspace-status computation
  - avoid recomputing built-in actions from live git state in the base response
- Introduce explicit secondary reads for expensive derived state if still needed.
- Rework parent-thread summary reads so they do not call the full thread hydration path.
- Audit all thread routes for avoidable hydrated existence checks and route lookups.
- Replace `threadManager.getById(...)` route checks with raw lookup helpers where hydration is not required.
- Known cases already identified in `apps/daemon/src/routes/threads.ts`:
  - `GET /threads/:id/default-execution-options`
  - `PATCH /threads/:id`
  - `GET /threads/:id/output`
  - `GET /threads/:id` itself should be redefined as a lightweight read rather than a hydrated read

5. Replace request-path workspace status computation with cached snapshots

- Make workspace status watch/update flow the source of truth for current status snapshots.
- Store the latest computed status in daemon memory, keyed by thread/environment and merge-base options as needed.
- Serve `GET /threads/:id/work-status` from the cached snapshot when available.
- Recompute asynchronously on invalidation/watch events instead of synchronously on every fetch.
- Define fallback behavior for cache misses, startup, and restored environments.

6. Remove duplicate work-status computation from thread detail loads

- Stop fetching overlapping expensive state through both `GET /threads/:id` and `GET /threads/:id/work-status`.
- Choose one canonical source for workspace status on the thread detail page.
- Avoid issuing full parent-thread reads when only title/summary is needed.

7. Make operation acknowledgement cheap and optimistic

- Remove `_hydrateThreadState()` from the synchronous acknowledgement path for commit/squash/merge operations.
- Precompute or cache action availability where possible.
- Accept/queue the operation quickly, then perform heavier validation/work asynchronously.
- Update the app to optimistically reflect accepted operations in thread/timeline state before refetch completes.

8. Reduce timeline rebuild/refetch costs

- Stop treating every timeline invalidation as “refetch the full thread timeline”.
- Add incremental timeline fetch/append semantics based on sequence or cursor.
- Preserve timeline cache while switching threads when safe.
- Reassess current websocket invalidation debounce/throttle values after the backend is no longer blocking.

9. Reduce thread-detail request fan-out and loading states

- Audit which requests are strictly required for first paint vs follow-up enhancement.
- Remove `refetchOnMount: "always"` from thread/timeline queries unless there is a demonstrated correctness requirement.
- Use cached/placeholder data more aggressively during thread switches.
- Defer non-critical queries (`models`, `provider`, etc.) until after core thread content is rendered if they are not needed immediately.
- Map the current thread-detail request graph end to end, including layout-level and prompt-box-level queries.
- Explicitly classify each thread-detail fetch as one of:
  - required for first paint
  - required for interaction but can be deferred
  - globally cacheable system metadata
  - redundant / historical split that should be consolidated
- Known thread-detail/app-shell fan-out to account for:
  - thread
  - work-status
  - work-status with merge base
  - timeline
  - default-execution-options
  - parent-thread summary
  - models
  - provider
  - environments
  - projects
  - threads list
  - restart policy
- Reevaluate whether `default-execution-options` should remain a standalone route.
  - If the thread detail view always needs it, prefer either:
    - including it in a thread-detail aggregate response, or
    - including it on a lightweight thread detail payload when that does not force expensive hydration
  - Keep it separate only if it materially improves caching, reuse, or payload costs.
- Evaluate whether thread detail should move from many small independent routes toward a purpose-built composite read model for the initial screen.
- Account for development-only duplication from React `StrictMode` separately from true production request fan-out so measurements are not misleading.

10. Add guardrails and regression coverage

- Add tests proving production request paths no longer use sync child-process APIs.
- Add daemon tests for cached workspace status serving and async refresh behavior.
- Add end-to-end tests for:
  - thread switch latency
  - workspace-status update latency
  - operation acknowledgement latency
  - timeline append/update behavior
- Add perf assertions where practical, or at minimum snapshot timing logs in CI for the hottest routes.

# Validation

- Functional:
  - switch between multiple threads without long-lived `Loading thread...` states when data is already locally available
  - workspace status changes appear promptly after file/git changes
  - commit/squash/merge actions acknowledge quickly and appear in the timeline immediately
- Instrumentation:
  - daemon logs show low queueing time and low event-loop delay under normal localhost usage
  - request total time and handler time stay aligned; large gaps should be treated as regressions
- Codebase checks:
  - `rg "spawnSync|execSync" apps packages --glob '!**/__tests__/**' --glob '!**/scripts/**'`
  - repository guard/lint passes
- Test suites:
  - `pnpm --filter @beanbag/daemon test`
  - `pnpm --filter @beanbag/environment test`
  - `pnpm --filter @beanbag/agent-server test`
  - `pnpm --filter @beanbag/app test`
  - targeted typechecks/builds for touched packages

# Open Questions/Risks

- Some environment operations may still need strong ordering semantics; replacing sync execution with async work must not introduce races or inconsistent snapshots.
- Cached workspace status may need separate cache keys for merge-base-sensitive views; otherwise we risk serving stale or mismatched status.
- Docker/local/worktree environments may not all support the same async migration shape; we should avoid a one-size-fits-all abstraction if it obscures failure handling.
- If action availability becomes cached, we need a clear invalidation model so buttons do not drift from actual backend capability.
- Eliminating `spawnSync` everywhere is the right direction, but it should be staged: request-path and hot-path removal first, then startup/utilities, then remaining non-critical production calls.
- Consolidating thread-detail routes has a tradeoff:
  - fewer round trips and less client orchestration
  - but potentially more coupling between independently cacheable resources
  We should make that tradeoff deliberately based on real usage, not current historical route boundaries.
- Development-mode request counts are inflated by `React.StrictMode`; we should validate request-count and latency improvements in a production build too, so we do not optimize around development-only duplication.
