# CLI Command Output Audit + Usability Plan

## Goal

Define and implement clear, consistent, useful output contracts for all `bb` CLI commands so callers can:

- orient quickly (`bb status`)
- inspect entities reliably (`bb project|task|thread ...`)
- perform operations with predictable feedback
- debug only when explicitly requested (without default noise)
- script commands safely (stable output modes)

## Scope

In scope:

- `apps/cli/src/commands/status.ts`
- `apps/cli/src/commands/project.ts`
- `apps/cli/src/commands/task.ts`
- `apps/cli/src/commands/thread.ts`
- shared CLI formatting helpers (new or existing)
- docs updates in `README.md`

Out of scope:

- daemon API shape changes unless required for CLI contract guarantees
- web UI behavior changes

## Current Findings

1. `bb task status` and `bb thread status` include `Recent events` by default, which often surfaces low-signal/internal lifecycle types rather than user-meaningful activity.
2. status commands fetch full event lists and then only render the last 3 types, which is expensive relative to usefulness.
3. `bb status` previously had asymmetric enrichment (description shown without title), which is confusing and violates basic entity completeness.
4. `bb status` purpose drifted from pure context display to context + remote enrichment; this is acceptable but needs explicit output contract and failure behavior.
5. command input ergonomics are inconsistent across similar commands (`status [id]` supports context fallback, while `show <id>` does not).
6. `thread spawn --task-role` silently no-ops when no task context is supplied.
7. event log formatting differs between `task events` and `thread log`, making cross-command usage harder.
8. command output contracts are not broadly protected by snapshot/contract tests, so regressions have been easy to introduce.

## Target Output Contracts

### `bb status`

- Always print:
  - `Project: <id|<unset>>`
  - `Task: <id|<unset>>`
  - `Thread: <id|<unset>>`
- If task id is set, attempt to enrich with:
  - `Task Title: ...`
  - `Task Description: ...`
- If enrichment fails:
  - `Task Title: <unavailable>`
  - `Task Description: <unavailable>`

### `bb task status` and `bb thread status`

- Default output should be concise and actionable summary only.
- Recent event details must be opt-in, not default.
- Add explicit flags for event inclusion and verbosity.

### `bb task show` and `bb thread show`

- Support context fallback in addition to explicit id for consistency with `status`.
- Keep structured detail output; include task description and role metadata where available.

### `bb task events` and `bb thread log`

- Keep raw diagnostics behavior.
- Standardize formatting style and timestamp format across both commands.
- Optionally add a filtered/summary mode rather than forcing raw-only output.

### `bb thread spawn`

- Validate `--task-role` usage against task context.
- Return clear error when `--task-role` is provided without effective task id.

## Proposed Design

### Audit Checklist (Required Gate)

Every CLI output change must pass this checklist:

1. Purpose check: command output matches command intent (context vs summary vs diagnostics).
2. Completeness check: if an entity field implies a companion field, both must be present.
3. Symmetry check: task identity enrichment requires both `Task Title` and `Task Description`, never one without the other.
4. Fallback check: partial fetch failures use explicit placeholder values, not silent omission.
5. Noise check: defaults are concise; detailed internals are opt-in.
6. Consistency check: same concepts use the same labels/order across commands.
7. Scriptability check: human and JSON modes are explicit and predictable.

### 1) Introduce Shared CLI Output Profiles

Add shared helpers for:

- timestamp formatting
- entity summary blocks
- optional event rendering (`summary` vs `raw`)
- low-signal event filtering

Use these helpers across task/thread status and event commands.

### 2) Make Status Event Details Explicit

For task/thread status commands:

- remove default `Recent events` section
- add `--recent-events <n>` to include last `n`
- add `--event-mode summary|raw` (default `summary`)
- add `--include-low-signal` for diagnostics

### 3) Event Signal Taxonomy

Define shared classification for task/thread events:

- high-signal: assignment changes, status transitions, thread created/completed, assistant outputs, errors
- low-signal: internal lifecycle and transport/noise events

Apply this taxonomy in CLI status event summaries and keep raw mode unfiltered.

### 4) Consistent Context Fallback and Errors

Normalize argument behavior:

- convert `show <id>` to `show [id]` where context fallback is useful
- ensure all context-dependent commands return similarly-worded missing-context errors

### 5) Scriptability

Add `--json` for status/show/list commands with stable shape and no decorative text.

This keeps human output optimized for readability while preserving automation reliability.

## Detailed Work Plan

### Phase 1: Contract Lock-In + Low-Risk Cleanup

1. Document target outputs in command comments and README CLI section.
2. Add/expand shared formatting helpers.
3. Keep current `bb status` enrichment behavior and codify fallback text.
4. Add tests for:
   - `bb status` with/without task context and fetch failure
   - `bb status` always emits title+description together when task context is present
   - `bb task show` includes description
   - `bb task status` baseline summary fields

### Phase 2: Status Noise Reduction

1. Remove default `Recent events` from task/thread status.
2. Add `--recent-events <n>`.
3. Add event filtering helpers and `--include-low-signal`.
4. Add `--event-mode summary|raw`.
5. Update tests to verify default quiet behavior and opt-in event behavior.

### Phase 3: Consistency + Guardrails

1. Convert `task show` and `thread show` to optional id with context fallback.
2. Add validation for `thread spawn --task-role` when no task context exists.
3. Standardize task/thread event log formatting.
4. Update help text examples and error copy.

### Phase 4: JSON Output Mode

1. Add `--json` to status/show/list command set.
2. Define stable response schemas per command.
3. Add contract tests for JSON mode (shape and key presence).

## Testing Plan

1. Add command-level output contract tests in `apps/cli/src/__tests__` (stdout/stderr capture).
2. Keep helper unit tests for formatters/classifiers.
3. Add regression tests for event noise defaults.
4. Add tests for spawn option validation (`--task-role` without task context).
5. Run:
   - `pnpm --filter @beanbag/cli test`
   - `pnpm --filter @beanbag/cli typecheck`

## Rollout Sequence

1. Phase 1 + Phase 2 first to fix immediate usability pain (`status` noise).
2. Phase 3 for consistency and guardrails.
3. Phase 4 for scriptability improvements.

This sequence reduces risk while delivering immediate value early.

## Exit Criteria

1. `bb status` contract is explicit, tested, and stable.
2. `bb task status`/`bb thread status` are concise by default and do not show low-signal events unless requested.
3. Event rendering style is consistent across task/thread logs.
4. Context fallback and option validation behavior is consistent across related commands.
5. JSON output mode exists for key status/show/list surfaces with tests.
