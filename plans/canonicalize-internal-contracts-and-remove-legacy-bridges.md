# Goal

Bring the app, daemon, and shared packages back to one canonical way of representing internal state by removing stale compatibility layers, finishing partial cutovers, and replacing heuristic behavior with typed internal contracts.

# Scope

This plan covers the cleanup work identified in the audit across:
- daemon HTTP error responses and client error parsing
- app prompt-composer capability/model/environment loading
- persisted thread event storage, pruning, and UI projection
- thread detail row collapsing logic for operation events
- shared UI primitive adoption in the app shell and thread detail surfaces

This plan does not cover:
- generated schema cleanup under `packages/core/src/generated/**`
- provider/runtime compatibility that is truly `open_external`
- unrelated environment-boundary work already tracked in [environment-abstraction-leaks-plan.md](/Users/michael/.codex/worktrees/64fa/bb/plans/environment-abstraction-leaks-plan.md)

# Implementation Steps

1. Standardize daemon route error responses behind one internal contract.
   - Move `apps/daemon/src/routes/projects.ts` onto the same `sendRouteError()` path used by `threads.ts` and most of `system.ts`.
   - Decide whether the `error` field alias in `apps/daemon/src/routes/error-response.ts` is still required by any real client.
   - If the alias is still temporarily needed, isolate it at the final response boundary and stop emitting ad hoc `{ error }` bodies elsewhere.
   - Normalize special-case route responses such as shutdown-blocked and multipart validation failures so clients do not need shape-specific parsing heuristics.

2. Tighten client-side HTTP error handling around the canonical daemon shape.
   - Update `apps/app/src/lib/api.ts` to prefer one typed daemon error body instead of probing `message`, `error`, and `detail` as equal peers.
   - Decide whether `apps/cli/src/client.ts` should share the same error parsing helper as the app instead of reporting raw response text.
   - Add a narrow compatibility window only if older daemon versions must remain supported during development; document the cutoff explicitly.

3. Remove internal prompt-composer fallbacks that currently hide capability/catalog failures.
   - Replace hardcoded fallback models and environments in `apps/app/src/hooks/usePromptModelReasoning.ts` with explicit loading/error/unavailable states for internal data sources.
   - Treat provider capabilities such as `supportsModelList` and `supportsReasoningLevels` as internal contract data, not best-guess booleans.
   - Keep only fallbacks that are truly `open_external` and intentional; add comments where unknown values are still tolerated by design.
   - Simplify the hook once fallback state is reduced so selection hydration, capability coercion, and persistence are easier to reason about.

4. Finish the event history cutover to the canonical normalized event surface.
   - Audit which legacy `codex/event/*` rows are still produced, still read, or only retained for historical inertia.
   - Remove retention rules that preserve legacy rows when the canonical `item/*`, `turn/*`, and `thread/*` events already cover the supported UI/debug surfaces.
   - Prefer a one-time migration or bounded pruning step over indefinite dual-format support in steady-state reads.
   - Update tests in `packages/db` and `packages/agent-core` to assert the new supported history model rather than preserving ignored legacy rows.

5. Make row collapsing metadata-driven instead of title-driven.
   - Treat `primaryCheckout` and `threadOperation` metadata as the only canonical basis for merge/collapse behavior in `packages/agent-core/src/thread-detail-rows.ts`.
   - Remove title-parsing heuristics once the upstream projection in `packages/agent-core/src/to-ui-messages.ts` reliably emits structured metadata.
   - For genuinely older persisted rows, choose one explicit compatibility strategy:
     - migrate them forward, or
     - render them as unmerged standalone operation messages.
   - Do not keep string-title inference as a permanent behavioral dependency.

6. Reduce duplicate UI primitive import paths and route-level composition drift.
   - Choose one app-facing import path for shared UI primitives used by the app: either direct `@beanbag/ui-core` imports or app-local wrappers, but not both.
   - Remove trivial pass-through wrappers such as `StatusPill` and `CollapsibleHeader` if they are not adding app-specific behavior.
   - Revisit `apps/app/src/views/ThreadDetailView.tsx` after the event/row cleanup to extract route-local concerns into focused helpers or shared components where it reduces branching and state coupling.
   - Keep one canonical message rendering path centered on `ConversationEntry` and the `agent-core` row builder.

7. Shrink oversized coordination surfaces after contract cleanup lands.
   - Break follow-up refactors into behavior-preserving slices rather than rewriting `packages/agent-core/src/to-ui-messages.ts` or `apps/app/src/views/ThreadDetailView.tsx` in one pass.
   - Use the contract cleanup from steps 1-6 to remove branches first, then extract helpers once the remaining logic has a stable center.
   - Favor deleting dead branches and compatibility code over introducing new abstraction layers too early.

# Validation

- Before code changes that depend on built artifacts, run:
  - `pnpm install`
  - `pnpm build`
- For daemon error-contract work:
  - run targeted daemon route tests
  - run app and CLI tests that exercise HTTP error parsing
- For event history and row-building cleanup:
  - run targeted `packages/db` and `packages/agent-core` tests
  - run app thread-detail tests that cover timeline rendering and grouping
- For prompt-composer cleanup:
  - run the hook/component tests around prompt defaults and capability handling
- After the full series lands, run the repo test command that covers all touched packages.

# Open Questions/Risks

- Mixed-version compatibility: if developers routinely run newer app code against older daemons, a short compatibility window may still be required for error bodies and event history reads. If so, define a concrete removal point up front.
- Historical data risk: removing legacy `codex/event/*` retention may affect old local databases. A migration/pruning strategy should be explicit so the supported upgrade path is clear.
- UX risk: removing prompt-model/environment fallbacks can expose loading and outage states that were previously hidden. The UI should make those states actionable rather than simply disabling controls without explanation.
- Refactor scope risk: `to-ui-messages.ts` and `ThreadDetailView.tsx` are large enough that cleanup can sprawl. Keep each change tied to a contract simplification and validate incrementally.
