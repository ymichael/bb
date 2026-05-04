# Repository Accidental Complexity Cleanup

## Motivation

The timeline sequence incident exposed one specific bad ownership boundary
between server and daemon. The repo-wide audit shows the same pattern in other
places: packages named for one concern export unrelated helpers, production
contracts carry development-only tooling, route contracts accept optional fields
that are defaulted much later, and durable state stores JSON payloads whose real
type is rediscovered in service code.

The goal of this plan is to remove the remaining accidental complexity around
ownership boundaries. Most phases can proceed independently of the protocol
roadmaps; only the durable payload and lifecycle abstraction phases need to wait
for the server/daemon protocol changes that reshape command results and
lifecycle ownership.

This plan does not replace:

- `plans/host-daemon-event-protocol-hard-cutover.md`
- `plans/server-daemon-protocol-simplification.md`

Those two plans remove the largest correctness risk and should lead protocol
implementation. This plan covers repository-level simplification work that is
not fundamentally a daemon transport problem. Phases 1, 2, 3, 4, 7, and 8 can be
scheduled independently; Phases 5 and 6 should wait for the protocol work that
changes durable command/result ownership.

## Current Status (2026-05-04)

Open future work. The short-term timeline safety fixes have landed separately in
this branch and do not implement this cleanup roadmap. This plan remains a
repository-structure follow-up after the immediate timeline bug fixes are
reviewed.

The repo still has several structural issues that make correctness depend on
discipline instead of ownership:

- `@bb/core-ui` exports generic helpers, pending-interaction product formatting,
  environment display formatting, and error helpers, then is imported by server,
  CLI, app, and `@bb/ui-core`.
- `@bb/host-runtime-material` imports runtime material schemas and types from
  `@bb/host-daemon-contract`, reversing the intended ownership direction.
- `@bb/server-contract/src/api-types.ts` is a monolith that mixes unrelated
  route contracts and re-exports development replay schemas.
- Public route schemas accept optional execution fields and internal services
  resolve defaults later, so defaulting is not isolated at the boundary.
- Durable payloads for lifecycle operations, commands, events, drafts, and
  pending interactions are stored as JSON strings and parsed in scattered service
  code.
- Frontend realtime cache effects encode product invalidation policy in a large
  client-side switch instead of following a narrow server-owned change contract.
- Several existing cleanup plans overlap. `plans/code-quality-follow-ups.md`,
  `plans/thread-view-package-boundary.md`, and `plans/ui-core-design-system.md`
  have useful details, but the remaining work needs one ordering that follows
  the ownership lens.

## Target Architecture

- Package names describe actual ownership. A package should not become a
  dumping ground for helpers just because it is easy to import.
- Product formatting lives with the product surface that owns it:
  timeline/pending-interaction timeline copy in `@bb/thread-view`, React
  rendering in `@bb/ui-core`, app glue in `apps/app`, CLI formatting in
  `apps/cli`.
- Pure utility code lives in a deliberately tiny package only when it has
  multiple package consumers and no product semantics. A package like `@bb/std`
  is allowed because it owns its helpers directly; it must not become a
  cross-package re-export bridge.
- Runtime material schemas are owned by `@bb/host-runtime-material`, not by the
  daemon transport contract.
- Public API contracts are split by route/domain and do not include
  development-only contracts in production root exports.
- Route boundaries fill defaults once. Internal services receive explicit,
  resolved values.
- Durable persistence helpers parse and validate typed payloads at the data
  boundary or lifecycle-owner boundary, not opportunistically in callers.
- Frontend realtime cache invalidation is a thin mapping from server-owned
  change semantics to query keys.

## Implementation Plan

### Phase 1: Delete `@bb/core-ui`

Goal: remove the misleading shared package and move each export to its real
owner.

Changes:

- Create a tiny pure utility package, `@bb/std`, only for helpers with no product
  imports and at least three package consumers:
  - `assertNever`
  - `extractErrorMessage`
  - `toRecord`
  - compact time/duration formatting if both CLI and app still need the same
    output.
- Treat `@bb/std` as an owning utility package, not a workaround for the
  no-reexports rule. It may export helpers it defines locally; it must not
  re-export product/domain modules from other packages.
- Move environment display formatting to the consumer that owns the product
  presentation. If both CLI and app need the same exact copy, put it in a narrow
  domain presentation module, not in a generic utility package.
- Move pending-interaction timeline/presentation formatting into
  `@bb/thread-view` when it is timeline/CLI/audit copy, or into `@bb/ui-core`
  when it is React-only rendering.
- Update server imports so server code no longer imports any package with UI
  ownership.
- Delete `packages/core-ui`.

Staged rollout:

1. Move pure helpers into `@bb/std` and switch all existing callers.
2. Move pending-interaction timeline/audit formatting into `@bb/thread-view` and
   React-only rendering into `@bb/ui-core`.
3. Move environment display formatting to the product owner used by app/CLI, or
   create a narrow presentation module if the exact copy is intentionally shared.
4. Remove all server imports from UI-owned packages.
5. Delete `packages/core-ui` after `rg "@bb/core-ui" apps packages` is clean.

Exit criteria:

- `rg "@bb/core-ui" apps packages` returns no matches.
- `packages/core-ui` is deleted.
- `@bb/std` has no imports from `@bb/domain`, `@bb/server-contract`,
  `@bb/thread-view`, React, or app code.
- `pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/app --filter=@bb/cli --filter=@bb/ui-core --filter=@bb/thread-view` passes.

### Phase 2: Move Runtime Material Ownership

Goal: make runtime material own its durable shape and file/state behavior.

Changes:

- Move `hostRuntimeMaterialSnapshotSchema`,
  `HostRuntimeMaterialSnapshot`,
  `HostRuntimeMaterialManagedFile`, and runtime material file-name constants into
  `@bb/host-runtime-material`.
- Update `@bb/host-daemon-contract` to import those schemas/types from
  `@bb/host-runtime-material`.
- Update sandbox, server, and host-daemon imports to depend on
  `@bb/host-runtime-material` when they are handling runtime material rather than
  daemon transport.
- Keep daemon session routes responsible only for transport shape.

Exit criteria:

- `rg "@bb/host-daemon-contract" packages/host-runtime-material` returns no
  matches.
- Runtime material tests still cover snapshot version stability, managed file
  path safety, and persisted state parsing.
- `pnpm exec turbo run typecheck --filter=@bb/host-runtime-material --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/host-daemon` passes.

### Phase 3: Split Public API Contracts By Domain

Goal: make contract ownership visible and stop unrelated routes from sharing a
single large contract file.

Changes:

- Split `packages/server-contract/src/api-types.ts` into domain modules:
  - `threads.ts`
  - `projects.ts`
  - `environments.ts`
  - `hosts.ts`
  - `automations.ts`
  - `system.ts`
  - `attachments.ts`
  - `timeline.ts` if it is not already sufficiently isolated.
- Keep `packages/server-contract/src/index.ts` as a narrow re-export surface.
- Move development replay API contracts into a dev-only module that is not
  exported from the production root contract.
- Route files import only their domain contract module or the root re-export for
  public types that are intentionally stable.

Exit criteria:

- `packages/server-contract/src/api-types.ts` is deleted or reduced to a
  temporary compatibility re-export with no schema definitions.
- Development replay schemas are not exported from the production root module.
- Route-level contract changes no longer touch an unrelated 1,000-line file.
- `pnpm exec turbo run typecheck --filter=@bb/server-contract --filter=@bb/server --filter=@bb/app --filter=@bb/cli` passes.

### Phase 4: Resolve Defaults At Route Boundaries

Goal: stop passing partially specified execution requests through internal
services.

The server already has `resolveExecutionOptions()` in
`apps/server/src/services/threads/thread-runtime-config.ts`. Extend that pattern
so every entrypoint resolves public partials at the route or scheduling boundary
and passes explicit `ResolvedThreadExecutionOptions` internally.

Changes:

- Define route request schemas that describe exactly what callers may omit.
- Add or standardize boundary resolvers that convert public requests into
  internal resolved request types.
- Enumerate and update these entrypoints:
  - standard thread creation;
  - standard turn sending and active-turn steering;
  - manager thread creation;
  - manager child-thread creation;
  - queued drafts and auto-send;
  - automations;
  - scheduled manager nudges.
- Change command construction and lifecycle services behind those entrypoints to
  accept explicit resolved execution values.
- Delete optional internal execution fields such as optional model,
  service tier, reasoning level, and permission mode where they are used only to
  mean "apply the default."
- Preserve optional fields only when absence has a real semantic meaning.

Exit criteria:

- Internal thread lifecycle and command construction APIs accept resolved
  execution options, not public request partials.
- `rg "model\\?|serviceTier\\?|reasoningLevel\\?|permissionMode\\?" apps/server/src/services packages/domain/src` has no matches for internal defaulting paths.
- Tests cover route boundary defaulting for app, CLI, automation, manager, and
  queued draft paths.
- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/domain --filter=@bb/server-contract > /tmp/bb-default-boundary-test-out.txt 2>&1` passes.

### Phase 5: Type Durable Payloads At Ownership Boundaries

Goal: replace scattered JSON parsing with typed persistence accessors.

Sub-phases by owner:

1. Thread provisioning owner:
   - add typed serializers/parsers for thread provisioning operation payloads;
   - replace service-level `JSON.parse(operation.payload)` for thread
     provisioning with owner accessors.
2. Environment lifecycle owners:
   - add typed accessors for environment provisioning and environment cleanup;
   - keep cleanup intent/progress fields owned by the environment lifecycle
     module, not generic metadata helpers.
3. Host/runtime/project owners:
   - add typed accessors for host runtime material and project source operations;
   - keep runtime-material payload ownership aligned with Phase 2 of this plan.
4. Draft and interaction owners:
   - add typed payload accessors for queued drafts and pending interactions;
   - keep repeated request, expiration, and reconciliation semantics with those
     owners.
5. Command/result owners, after the server/daemon protocol plan lands:
   - remove generic stored result reconstruction where command owners no longer
     need it;
   - type any remaining stored result payload at the command owner boundary.
6. Event/projection owner:
   - keep the event log JSON-backed if needed, but expose typed event-row
     accessors and avoid `Record<string, unknown>` inside internal projection or
     lifecycle code.

Each sub-phase should have its own PR-sized exit criteria and migration tests
for any payload shape that changes.

Exit criteria:

- `rg "JSON\\.parse\\(.*payload|JSON\\.parse\\(operation\\.payload|JSON\\.parse\\(commandRow\\.payload" apps/server/src packages/db/src` returns no production matches except inside typed parser modules.
- Lifecycle owner tests fail on malformed persisted payloads with clear errors.
- Each lifecycle owner listed above has a focused malformed-payload test.
- No generic helper accepts arbitrary lifecycle `payload: string` without a kind-specific parser.
- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/db --filter=@bb/domain > /tmp/bb-typed-payload-test-out.txt 2>&1` passes.

### Phase 6: Narrow Lifecycle Operation Abstractions

Goal: keep shared lifecycle mechanics only where they clarify ownership.

Changes:

- After typed payload accessors exist, audit
  `packages/db/src/data/lifecycle-operation-helpers.ts`.
- Keep generic helpers for shared state transitions only if the states and fields
  are actually identical across operation owners.
- Move owner-specific identity, payload, command attachment, and failure
  semantics into owner repositories or service modules.
- Delete generic extension points that exist only to support one caller.

Exit criteria:

- Lifecycle operation code makes it obvious which module owns each operation
  kind.
- Generic helpers do not accept owner-specific payloads, failure details, or
  lifecycle policy.
- Tests cover repeated requests, lost daemon results, expired commands, and
  reconnect reconciliation for each durable lifecycle owner.

### Phase 7: Simplify Frontend Realtime Cache Effects

Goal: make the client a cache invalidation consumer, not a lifecycle policy
owner.

Changes:

- Define a small server-owned change contract for threads, environments, hosts,
  projects, and system resources.
- Replace large client-side change interpretation with exact query-family
  invalidation helpers.
- Delete optimistic or derived cache updates that duplicate server state unless
  they are needed for visible latency and have tests proving correctness.
- Keep UI-local buffering/debouncing only for render performance, not durable
  correctness.

Exit criteria:

- `apps/app/src/hooks/realtime-cache-effects.ts` is at most 180 lines and is
  mostly dispatch and query-key mapping, not product lifecycle logic.
- `apps/app/src/hooks/realtime-cache-effects.ts` does not branch on raw product
  lifecycle event types except to map a server change kind to query families.
- Reconnect invalidation has a small documented list of query families.
- Pending interaction state in thread lists comes from server responses or
  targeted invalidation, not a separate client-side truth.
- Tests assert the query families invalidated for thread, environment, host,
  project, and system changes.
- `pnpm exec turbo run test --filter=@bb/app` and
  `pnpm exec turbo run typecheck --filter=@bb/app` pass.

### Phase 8: Consolidate Or Supersede Older Cleanup Plans

Goal: avoid maintaining several overlapping cleanup roadmaps.

Changes:

- Review `plans/code-quality-follow-ups.md`,
  `plans/thread-view-package-boundary.md`, and
  `plans/ui-core-design-system.md`.
- Move any still-relevant unchecked work into this plan or into a more specific
  owner plan.
- Delete plans whose exit criteria are completed or fully superseded.

Exit criteria:

- No two plan files describe the same cleanup target with different owners.
- Completed or superseded plan files are deleted.
- Remaining plan files each have clear exit criteria and validation commands.

## Validation

Run focused typechecks and tests after each phase. At minimum for the whole plan:

```bash
pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/app --filter=@bb/cli --filter=@bb/db --filter=@bb/domain --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/host-runtime-material --filter=@bb/thread-view --filter=@bb/ui-core
```

```bash
pnpm exec turbo run test --filter=@bb/server --filter=@bb/app --filter=@bb/db --filter=@bb/domain --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/host-runtime-material --filter=@bb/thread-view --filter=@bb/ui-core > /tmp/bb-repo-cleanup-test-out.txt 2>&1
git diff --check
```

Manual validation:

1. Start the dev server and host daemon.
2. Create a standard thread from the app.
3. Create a manager thread.
4. Send a follow-up turn and a steer.
5. Trigger and resolve a pending interaction.
6. Open project file search, workspace diff, thread storage, and environment
   status views.
7. Exercise CLI thread show/wait/interactions commands.
8. Exercise development replay only in dev mode.

## Completion Criteria

This roadmap is complete when:

- `@bb/core-ui` is deleted.
- Runtime material schemas are no longer owned by the daemon transport contract.
- Public API schemas are split by domain and production root exports exclude
  development-only replay.
- Internal services receive resolved defaults rather than public partial
  requests.
- Durable payload parsing is centralized in typed owner modules.
- Lifecycle operation abstractions are owner-specific where behavior differs.
- Frontend realtime cache code is a thin invalidation layer.
- Older overlapping cleanup plans are deleted or narrowed so each remaining plan
  has a single clear owner.
