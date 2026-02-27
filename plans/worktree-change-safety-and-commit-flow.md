# Worktree Change Safety + Commit Flow Plan

## Goal

Make worktree mode feel safe and obvious by giving users clear change-state visibility, one-click commit actions, and guardrails that prevent archiving or context switches from losing unmerged work.

## Scope

- Add thread-scoped change tracking surfaced in thread and project UI.
- Improve worktree environment setup so agents can run tests/commands reliably.
- Clarify lifecycle states: uncommitted changes, committed-but-unmerged, clean/safe.
- Add commit CTAs in thread header and project view.
- Add archive protections for threads with unmerged or uncommitted work.
- Cover both `worktree` and `local` environments with consistent status language.
- Add project-level workflow instructions (plaintext) that guide agent working style.

Out of scope (initial pass):

- Full in-app diff browser.
- Auto-merge/cherry-pick orchestration across branches.
- Remote/GitHub PR automation.

## Implementation Steps

1. Define a canonical “thread work status” model (shared contract + daemon API)
   - Add a closed-internal union for thread work state:
     - `clean`
     - `dirty_uncommitted`
     - `committed_unmerged`
     - `dirty_and_committed_unmerged`
   - Include summary metrics for fast UI display:
     - changed file count
     - insertions/deletions
     - ahead/behind vs detected default branch
     - current branch/worktree path metadata
   - Compute via git plumbing in daemon and expose through thread/project endpoints.

2. Detect and persist the project’s default/base branch
   - Resolve base branch per project (prefer remote HEAD, fallback to local default branch convention).
   - Store resolved base branch in project metadata and reuse for `committed_unmerged` comparisons.
   - Ensure repositories using `master` (or non-`main`) are handled without manual config.

3. Implement robust worktree environment provisioning checks
   - On worktree creation, run deterministic bootstrap checks (toolchain, deps, env vars, repo hooks if needed).
   - Persist provisioning result on thread/worktree (`ready`, `degraded`, `failed`) with actionable message.
   - Show status in UI so users know whether test execution is expected to work.
   - Add a “re-run setup” action for degraded/failed setups.

4. Surface change state in composer/thread UX (“hat” above prompt)
   - Add compact change summary above composer: “X files changed (+Y/-Z)”.
   - Keep v1 read-only (no full diff viewer yet), but make status always visible when non-clean.
   - Ensure thread state updates after agent actions and manual git operations.

5. Add high-signal status indicators in sidebar + headers
   - Thread header + sidebar badge with explicit state text:
     - “Uncommitted changes”
     - “Committed, not merged to default branch”
     - “Clean (safe to archive)”
   - Project-level view should aggregate and highlight threads with risky states.
   - Use consistent iconography/color semantics across local/worktree.

6. Add commit actions (thread + project)
   - Primary “Commit” button enabled only when uncommitted changes exist.
   - Default behavior: auto-generate commit message (agent summary + timestamp), allow optional edit.
   - Split-button/dropdown for advanced options (custom message/amend/no-verify if allowed).
   - On success, immediately recompute and display whether commits are still unmerged.

7. Add archive safety rails (warning-confirmed, not hard-blocked)
   - Intercept archive for non-clean threads.
   - Require explicit confirmation when `dirty_uncommitted` or `committed_unmerged` state exists.
   - Default safe CTAs: “Commit now”, “View status”, then “Archive anyway”.
   - Do not hard-block archive; user can continue after explicit warning.

8. Clarify merge-back workflow into default branch
   - Add a small “How to land this work” help surface for worktree threads:
     - current branch
     - detected default branch
     - whether branch is ahead of default branch
     - suggested next command(s) or action path
   - In project view, add a filter/section for “Ready to merge” threads.

9. Add project workflow instructions (plaintext)
   - Add a project-level editable text field for preferred workflow instructions.
   - Inject this context into agent runs so users can specify norms (e.g., commit cadence, test expectations, merge style).
   - Keep it global per project (no per-thread commit-message template system for now).

10. Implement efficient git change detection + refresh strategy
   - Use event-driven refresh where possible:
     - refresh after agent command execution, commit, checkout/merge actions.
     - watch `.git` and worktree filesystem signals (best effort) to catch out-of-band changes.
   - Add low-frequency background polling fallback (debounced, adaptive backoff when idle).
   - Cache last computed summaries and only recompute expensive diffs when HEAD/index/worktree mtime changes.

11. Add telemetry and diagnostics
   - Track setup failures, commit button usage, archive overrides, dirty-thread exits.
   - Track git refresh source (event/watch/poll) and recomputation duration.
   - Log git-status refresh errors with context to debug false clean/dirty reporting.

## Validation

- Unit tests
  - Work status classifier (all union states + exhaustive checks).
  - Default branch resolver (origin HEAD, fallback behavior).
  - Git summary parser and ahead/behind calculation.
  - Archive warning decision logic.

- Integration tests
  - Thread transitions across: clean → dirty → committed_unmerged → clean.
  - Worktree setup outcomes (`ready/degraded/failed`) and UI/API propagation.
  - Commit action from thread and project views.
  - Out-of-band git change updates via watch/poll fallback.

- Manual QA scenarios
  - Repo with `master` default branch reports correct unmerged status.
  - Worktree with missing deps shows degraded state and clear expectations.
  - Archive flow with dirty/unmerged work always warns before destructive action.
  - Local mode threads clearly indicate whether changes need commit.
  - User can always tell if work exists only off default branch.

Success metrics:

- Reduced cases of archived threads with uncommitted work.
- Increased commit-button adoption vs “Please commit your work” prompts.
- Lower rate of user-reported “lost work” incidents in worktree mode.
- Acceptable git status refresh latency/CPU under normal active-project usage.

## Open Questions/Risks

- How reliably can cross-platform file watching detect all out-of-band git mutations (`.git/index`, refs, packed-refs), and what fallback polling interval is safest?
- Should default branch be re-resolved periodically in case remote HEAD changes, or locked until manual refresh?
- How much workflow-instruction text should be injected into every run before token cost/verbosity becomes a concern?


## Delivery Phases

### Phase 1 (MVP Safety + Visibility)

- Implement thread work-status model (`clean`, `dirty_uncommitted`, `committed_unmerged`, `dirty_and_committed_unmerged`).
- Detect project default branch and use it for unmerged comparison.
- Show thread status badge in thread header/sidebar.
- Add archive warning confirm modal for non-clean threads.
- Add basic commit button in thread header.

Exit criteria:

- Users can always tell whether work is uncommitted/unmerged/clean.
- Archive never happens silently when risky work exists.

### Phase 2 (Workflow Efficiency)

- Add change-summary hat above composer (`files changed`, `+/-`).
- Add project-level commit action and risky-thread aggregation.
- Add “How to land this work” helper panel.
- Add initial telemetry for commit/archive/status refresh.

Exit criteria:

- Worktree-to-main path is explicit in UI.
- Commit actions reduce manual prompting significantly.

### Phase 3 (Resilience + Guidance)

- Add robust worktree provisioning state surfacing + retry action.
- Add project-level plaintext workflow instructions injected into agent context.
- Add hybrid git-change refresh strategy (watch + event + fallback poll) with tuning.

Exit criteria:

- Agents have reliable setup expectations in worktrees.
- Out-of-band git changes are reflected promptly without high idle CPU.
