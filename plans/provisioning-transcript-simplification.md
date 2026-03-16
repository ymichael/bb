# Provisioning Transcript Simplification

## Goal

Replace the typed, multi-interface transcript entry system with a simple `{ key, text, metadata?, startedAt? }` model. The frontend renders `text` verbatim. All formatting logic moves into the transformation/merge layer in `packages/core`. New environment types require zero frontend changes.

## Scope

- **In scope:** `UIProvisioningTranscriptEntry` union and all code that creates, merges, or renders it.
- **Out of scope:** The operation row title/status/collapse, worktree-commit/squash-merge rendering, `UIProvisioningMetadata` top-level fields (`setup.output`, `setup.scriptPath` — these serve the collapsible output panel, not transcript lines).

## New Entry Model

```ts
interface UIProvisioningTranscriptEntry {
  /** Dedup/replacement key — entries with the same key replace earlier ones. */
  key: string;          // e.g. "environment", "branch", "phase:start_provider_session"
  /** Display string rendered verbatim by the frontend. */
  text: string;
  /** Optional — only for in-progress entries; frontend appends live elapsed suffix. */
  startedAt?: number;
  /** Optional — structured data for debugging, not used for rendering.
   *  e.g. { branchName, headSha } or { phase, status, durationMs } */
  metadata?: Record<string, unknown>;
}
```

Replaces the current 6-interface discriminated union (`environment`, `worktree`, `branch`, `setup`, `phase`, `fallback`).

Array ordering is the display order — no `sourceSeq` needed.

## Current Architecture (for context)

### Creation (`packages/core/src/to-ui-messages.ts`)

Four event handlers create transcript entries:
- `system/provisioning/started` → `environment` + `worktree` entries
- `system/provisioning/progress` → `phase` entry
- `system/provisioning/env_setup` → `branch` + `setup` entries
- `system/provisioning/completed` → `environment` + `worktree` + `branch` + `fallback` entries

### Coalescing (`packages/core/src/thread-detail-rows.ts`)

Entries keyed by kind. Later event with same key replaces/merges. Supports "x-ing" → "x-ed" transitions (e.g. phase `started` → `completed`). Uses `sourceSeq` for re-sorting after merge.

### Rendering (`apps/app/src/components/messages/rows/OperationRow.tsx`)

`formatProvisioningTranscriptEntry` switches on `entry.kind`, formats each into a string. Also has a fallback path that builds lines from flat `UIProvisioningMetadata` fields when no transcript exists.

## Implementation Steps

### Step 1: Replace the type

In `ui-message.ts`, replace the 6-interface union with the single `UIProvisioningTranscriptEntry` interface above.

### Step 2: Move text formatting into `to-ui-messages.ts`

Move the formatting logic from `OperationRow.tsx` into helpers in `packages/core` (either in `to-ui-messages.ts` or a new `provisioning-text.ts` util). Each event handler produces entries with `text` already set:

| key | text examples |
|-----|--------------|
| `"environment"` | `"environment: Direct"`, `"environment: Worktree"` |
| `"worktree"` | `"creating worktree"` |
| `"branch"` | `"on branch main (b7afac5)"` (direct), `"checked out branch bb/thread-123 (b7afac5)"` (worktree) |
| `"setup"` | `"running .bb-env-setup.sh"` → `"ran .bb-env-setup.sh in 125ms"` |
| `"phase:start_provider_session"` | `"starting provider session"` → `"started provider session in 1.2s"` |
| `"fallback"` | `"fallback: <reason>"` |

The creation code already knows environment type, so the branch verb is determined at creation time — no sibling-sniffing needed.

Populate `metadata` with structured fields for debugging:
- branch: `{ branchName, headSha }`
- phase: `{ phase, status, durationMs }`
- setup: `{ status, scriptPath, durationMs }`

### Step 3: Simplify merge logic

In `thread-detail-rows.ts`, merge becomes: same `key` → incoming entry wins (take its `text`, `startedAt`, `metadata`). Keep the earlier entry's array position so display order is stable. Remove `sourceSeq`-based sorting, `provisioningTranscriptEntrySortRank`, and the per-kind merge functions.

The "x-ing" → "x-ed" transition still works because the later event produces a new entry with the completed `text` and the same `key`, which replaces the in-progress one.

### Step 4: Simplify frontend rendering

In `OperationRow.tsx`:
- `formatProvisioningTranscriptEntry` → return `entry.text` + optional elapsed suffix from `entry.startedAt`.
- Delete `formatProvisioningBranchLine`, `formatProvisioningPhaseLine`, `formatProvisioningSetupLine`.
- Remove the fallback path that builds lines from flat `UIProvisioningMetadata` fields — all provisioning events produce transcripts now.

### Step 5: Fix the original issue

Already handled by Step 2 — `to-ui-messages.ts` produces `"on branch main (b7afac5)"` for direct environments.

## Validation

- Update `ConversationEntry.test.tsx` provisioning tests for any wording changes (e.g. "on branch" vs "checked out branch" for direct).
- Update `thread-detail-rows.test.ts` for the new entry shape.
- `pnpm exec turbo run typecheck --filter=@bb/core --filter=@bb/app`
- Manual: direct env shows "on branch main (b7afac5)", worktree shows "checked out branch bb/thread-123 (b7afac5)".
- Manual: in-progress entries still show live elapsed time.

## Open Questions

1. **`metadata` shape:** Use `Record<string, unknown>` (loose) or a typed union (strict)? Recommend loose since it's for debugging, not rendering. Can always tighten later.
