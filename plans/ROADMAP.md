# ROADMAP

> Updated March 2, 2026 to focus on reliability, data/rendering unification, thread titling clarity, and dev-loop smoothness.

## Goal

Reduce user-risk and developer friction by making thread execution safer, message/data flows simpler, thread titling predictable, and local development resilient.

## Scope

- `apps/daemon` (thread lifecycle, titling, restart behavior, worktree safety)
- `apps/app` (message rendering, timeline/event consumption, daemon reconnect/restart UX)
- `apps/cli` (safe daemon restart entrypoints where useful)
- `packages/agent-core`, `packages/agent-server`, `packages/db`, `packages/ui-core` (event projection, dedupe, typed contracts, tests)

## Implementation Steps

1. **Protect user work first (Now / P0)**
   - Add git-backed reliability tests for worktree flows so we can assert “no lost work” across archive/stop/reconcile/error paths.
   - Strengthen safety invariants around worktree cleanup/destruction behavior.
   - Add regression coverage for high-risk paths (commit/squash-merge/conflicts/restart interactions).

2. **Fix the brittle development loop (Now / P0)**
   - Add a smoother daemon dev workflow (auto-reload and/or safe restart command path).
   - Define “safe to restart” checks (for example active threads, in-flight operations, pending workspace actions).
   - Add a client-visible recovery path when daemon/frontend are out of sync (clear reconnect + optional restart action).

3. **Unify data and rendering flows (Next / P1)**
   - Keep one canonical message rendering path (`ConversationEntry` + `ConversationWorkingIndicator`) and avoid alternate renderers.
   - Reduce parallel data paths where possible (timeline + raw events + legacy dedupe behavior) so UI state is derived consistently.
   - Clarify/centralize ownership of legacy event dedupe logic and projection rules.

4. **Audit and stabilize thread titling (Next / P1)**
   - Document title source precedence end-to-end (spawn title, derived title, generated title, provider rename event, manual rename).
   - Confirm architectural ownership (daemon vs. provider adapter/agent-server responsibilities).
   - Add targeted tests for “jarring re-title” scenarios and enforce predictable lock/override rules.

## Validation

- Reliability:
  - Git-backed integration tests prove no workspace loss across failure/restart/archive scenarios.
- Dev experience:
  - Daemon code changes no longer require fragile manual workflows; restart/reconnect flow is explicit and safe.
- Data/rendering:
  - Same thread state renders consistently across refreshes/reconnects without duplicate/contradictory message rows.
- Titling:
  - Thread title changes become explainable and deterministic under tests (including manual overrides).
- Standard checks:
  - `pnpm typecheck`
  - `pnpm test`
  - Local daemon + app smoke tests for spawn/tell/stop/archive/restart flows

## Open Questions/Risks

- What is the exact “safe restart” contract when there are active threads?
- Should title generation live primarily in daemon orchestration, or remain provider-driven with daemon constraints?
- How much legacy event compatibility do we retain vs. simplify now?
- How do we keep git-backed integration tests fast and stable enough for daily development use?
