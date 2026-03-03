# Agent-Driven Commit/Squash with Promotion Guardrails

## Goal
Make worktree promotion reliable while simplifying brittle commit/squash/conflict flows by shifting git mutation work to the thread agent. The daemon/UI should orchestrate safe state transitions and request agent actions, rather than directly performing most git writes.

## Scope
- Replace thread-level **commit** and **squash merge** UX flows with agent-directed operations.
- Keep/strengthen promotion + demotion as explicit daemon-owned checkout operations.
- Add clear guardrails for interactions between running threads, promoted state, and git actions.
- Replace project-main "commit" with "start a commit thread" workflow.
- Update API/UI/CLI/docs/tests for the new contract.

Out of scope:
- Multi-promoted-thread support.
- Full autonomous PR lifecycle (push/PR/open/review).
- Reworking provider/runtime internals unrelated to operation orchestration.

## Implementation Steps
1. **Define a state-policy matrix (single source of truth)**
   - Enumerate allowed/blocked behavior for combinations of:
     - thread status (`idle`, `active`, `provisioning*`, archived)
     - primary checkout state (promoted vs not)
     - requested operation (`promote`, `demote`, `commit-intent`, `squash-intent`)
   - Proposed defaults:
     - `promote`: blocked unless thread is `idle` and not archived.
     - `commit-intent`/`squash-intent`: allowed from idle/active, but always routed as an agent message (queued if active).
     - if thread is promoted, demote first before dispatching commit/squash intent.
   - Encode policy in shared daemon helper(s), not scattered route checks.

2. **Introduce operation-intent API in daemon**
   - Add a typed endpoint (e.g. `POST /threads/:id/operations`) for closed_internal ops:
     - `commit`
     - `squash_merge`
   - Request payload carries structured options (commit message hint, merge-base branch hint, include unstaged, etc.).
   - Daemon behavior:
     - validate policy matrix
     - auto-demote if required by policy
     - construct canonical agent instruction message template
     - dispatch via existing tell/queue path depending on active state
     - emit operation lifecycle events (`requested`, `dispatched`, `failed`)

3. **Convert thread detail commit/squash UI to intent dispatch**
   - Replace `commitThread` + `squashMergeThread` mutations with `requestThreadOperation`.
   - Keep current popover inputs, but map them to operation-intent payloads.
   - Remove daemon-level conflict-file special handling in UI; rely on agent response + normal thread conversation.
   - Show concise UX copy: operation requested / queued / failed.

4. **Convert project-main commit action to “start a commit thread”**
   - Remove direct `POST /projects/:id/commit` usage from ProjectMainView action.
   - New flow:
     - spawn a new thread in `local` environment
     - seed prompt with commit operation instruction template + user options
     - navigate user to that thread
   - Preserve auto-generated commit message behavior by delegating to agent workflow (not daemon commit API).

5. **Harden promotion/demotion guardrails**
   - Add explicit checks and clear errors for:
     - promote while thread active
     - promote/demote while another promote/demote op is in flight (per-project mutex)
     - promote when workspace root resolves to project root fallback (missing worktree)
   - Keep existing dirty-primary protection and rollback behavior.
   - Ensure demote is idempotent and remains safe default before non-promotion operations.

6. **Deprecate direct git mutation endpoints (phased)**
   - Phase A: keep `/threads/:id/commit`, `/threads/:id/squash-merge`, `/projects/:id/commit` but mark deprecated and route through operation-intent path when possible.
   - Phase B: remove UI/CLI references.
   - Phase C: remove endpoints/contracts after migration window.

7. **Contracts, events, and docs**
   - Add new API types for operation intents + lifecycle responses.
   - Add timeline projection for operation-intent events.
   - Document canonical prompts and expected agent behavior for commit/squash/conflict resolution.
   - Update CLI commands to request operations rather than direct daemon git actions.

## Validation
- **Unit tests (daemon):**
  - policy matrix enforcement across all operation/state combinations.
  - auto-demote before operation-intent dispatch.
  - queue vs immediate dispatch behavior for active vs idle threads.
  - per-project promotion mutex behavior.
- **Route/API tests:**
  - new operation-intent endpoint success/failure cases.
  - deprecated endpoint compatibility behavior.
- **UI tests:**
  - Thread detail commit/squash triggers intent request (not direct commit/squash API).
  - Project-main commit starts a new thread and seeds prompt correctly.
- **E2E/manual scenarios:**
  - promoted -> commit-intent (demotes then dispatches)
  - active thread -> squash-intent (queues safely)
  - conflict scenario handled through thread messages without daemon conflict post-processing.

## Open Questions/Risks
- How strict should we be on `promote while active` (hard block vs explicit override)?
- How deterministic can operation templates be across providers/models?
- Do we need operation timeouts/retry semantics for agent-dispatched intents?
- Should deprecated direct git endpoints remain available behind a feature flag for rollback?
- For project-main commit thread creation, should the thread auto-archive on successful commit summary detection?
