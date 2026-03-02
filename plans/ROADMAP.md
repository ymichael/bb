# ROADMAP

> Consolidation note (March 2, 2026): no existing `plans/*.md` files were present, so this is a new high-level seed roadmap.

## Goal

Create a single, high-level roadmap that aligns daemon, CLI, core packages, and web UX work so we can prioritize and iterate from one shared plan.

## Scope

- Cross-cutting product and platform direction for:
  - `apps/daemon`
  - `apps/cli`
  - `apps/web`
  - `packages/core`, `packages/db`, `packages/ui-core`
- Prioritization themes and sequencing, not task-level implementation detail.

## Implementation Steps

1. **Stabilize core workflows (Now)**
   - Harden thread lifecycle reliability (`spawn/tell/archive/reconcile`).
   - Tighten typed boundaries for internal unions and event projection paths.
   - Improve daemon/API error clarity for both CLI and web consumers.

2. **Unify user-facing experience (Next)**
   - Keep one canonical message rendering path in web (`ConversationEntry` + `ConversationWorkingIndicator`) and avoid reintroducing alternate renderers.
   - Continue reducing parallel message data paths (for example timeline vs. raw event consumers) where possible so UI behavior stays consistent.
   - Expand shared UI primitives to reduce local one-off components.
   - Standardize formatting/utilities (time, status, metadata) across surfaces.

   _Clarification: this does **not** imply duplicate message renderers today; current risk is drift from parallel/legacy data paths around rendering._

3. **Improve operator and agent ergonomics (Next)**
   - Make CLI status/debug flows faster for project/thread inspection.
   - Improve daemon introspection endpoints for state + event debugging.
   - Document best-practice troubleshooting via daemon API/CLI + SQLite checks.

4. **Expand runtime/provider flexibility (Later)**
   - Improve adapter discoverability/configuration for provider + environment.
   - Reduce integration friction for new providers while preserving typed contracts.
   - Add compatibility checks for provider/runtime schema changes.

5. **Raise confidence and release quality (Ongoing)**
   - Strengthen integration tests across daemon/web/cli boundaries.
   - Add targeted regression coverage for thread status transitions and event mapping.
   - Keep docs/contracts updated with implementation changes.

## Validation

- Roadmap review cadence: weekly quick pass, monthly reprioritization.
- For each active theme, track:
  - Success signal (reliability, UX consistency, dev speed)
  - Owner + target window
  - Explicit “in scope / out of scope” notes
- Validate delivered work via:
  - `pnpm typecheck`
  - `pnpm test`
  - Smoke checks in web UI + CLI against local daemon

## Open Questions/Risks

- How should we weight reliability work vs. net-new feature development each cycle?
- Which provider/environment integrations are strategic vs. maintenance-only?
- What minimum observability is required before scaling concurrent thread usage?
- Where do we need stricter backward-compatibility guarantees in API/event contracts?
