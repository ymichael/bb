# Code Quality Audit

Comprehensive audit of the bb codebase focused on maintainability, reuse, consistency, and code quality. Conducted 2026-03-25 against `main` branch.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Large Files and Decomposition](#1-large-files-and-decomposition)
3. [React Anti-Patterns (useEffect Misuse)](#2-react-anti-patterns-useeffect-misuse)
4. [Jotai and React Query Patterns](#3-jotai-and-react-query-patterns)
5. [Component Prop Design](#4-component-prop-design)
6. [Missing Shared Abstractions](#5-missing-shared-abstractions)
7. [Naming Drift and Stale References](#6-naming-drift-and-stale-references)
8. [Reinvented Wheels / Library Opportunities](#7-reinvented-wheels--library-opportunities)
9. [CLI-Specific Issues](#8-cli-specific-issues)
10. [Backend Package Assessment](#9-backend-package-assessment)
11. [Dead Code and Cleanup](#10-dead-code-and-cleanup)
12. [Suggested Improvements by Priority](#suggested-improvements-by-priority)

---

## Executive Summary

The backend packages (`@bb/db`, `@bb/workspace`, `@bb/domain`, `@bb/config`, `@bb/logger`, contracts) are in excellent shape: consistent function signatures using typed objects, good naming conventions, proper use of industry-standard libraries (Zod, Pino, Drizzle, envsafe), and clean separation of concerns. No major issues.

The frontend (`apps/app`) and CLI (`apps/cli`) carry the bulk of the debt. The primary concerns are:

- **Oversized files** — 4 files over 750 lines, with `ThreadDetailView.tsx` at 1,747 lines
- **useEffect chains** — `useThreadCreationOptions.ts` has 11 cascading effects that should be a reducer
- **Missing shared abstractions** — localStorage, dialogs, empty states, duration formatting are all reinvented per-use
- **Naming drift** — 72+ references still use `ThreadWorkStatus` naming despite the type being renamed to `WorkspaceStatus`
- **CLI table rendering** — identical pattern duplicated across 4 command files
- **Component prop sprawl** — `PromptBox` (20+ props) and `PromptExecutionControls` (20 props) need restructuring

The backend is clean. The frontend and CLI need targeted refactoring.

---

## 1. Large Files and Decomposition

Files that are too large to reason about, maintain, or review effectively.

| File | Lines | Issue |
|------|------:|-------|
| `apps/app/src/views/ThreadDetailView.tsx` | 1,747 | 162+ const declarations, 7 useEffects, 25+ imported hooks, multiple unrelated responsibilities |
| `apps/cli/src/commands/thread.ts` | 1,180 | 13 commands, 15+ helpers, 4 print functions, 3 error classes, 6 parsers — all in one file |
| `apps/app/src/hooks/useApi.ts` | 1,078 | 54 query/mutation hooks — acceptable as a hook factory but could split by entity |
| `apps/app/src/components/layout/ProjectList.tsx` | 838 | Manages project list, thread list, collapse state, archive dialogs, manager collapse — too many concerns |
| `apps/app/src/components/promptbox/PromptBox.tsx` | 758 | 20+ props, manages textarea auto-grow, mentions, attachments, zen mode, voice input |
| `apps/app/src/hooks/useThreadCreationOptions.ts` | 636 | 11 useEffect hooks managing cascading state validation |
| `apps/app/src/lib/api.ts` | 615 | API client — acceptable size for a centralized client |

### Recommended splits

**ThreadDetailView.tsx** — Extract into:
- `ThreadDetailViewShell` — route/params handling, data fetching orchestration
- `ThreadTimelineSection` — timeline display + scroll control
- `ThreadActionsBar` — top action buttons
- Custom hooks: `useThreadDebugView()`, `useThreadMergeBase()`, `useThreadFollowUpTracking()`

**thread.ts (CLI)** — Split into:
- `commands/thread/index.ts` — command registration
- `commands/thread/spawn.ts` — spawn logic
- `commands/thread/wait.ts` — wait/polling logic
- `commands/thread/show.ts` — show/formatting logic
- `commands/thread/actions.ts` — archive/delete/stop/tell
- `commands/thread/formatters.ts` — table printing

**PromptBox.tsx** — Extract:
- `PromptBoxInput` — core textarea + zen mode
- `PromptBoxMentions` — mention menu + suggestions
- `PromptBoxAttachments` — attachment display + preview

**useThreadCreationOptions.ts** — Consolidate 11 effects into a `useReducer` with validation logic in the reducer, extract localStorage sync into a `useLocalStorage` hook.

---

## 2. React Anti-Patterns (useEffect Misuse)

Per [react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect), many effects can be replaced by computing during render or handling in event handlers.

### Critical: Effect chains in useThreadCreationOptions.ts

This file has 11 `useEffect` hooks that form cascading state synchronization chains. When one piece of state changes, effects trigger in sequence to validate and reset dependent state. This is exactly the anti-pattern React docs warn about.

**Effects found (lines):** 411-415, 418-421, 435-447, 449-459, 461-473, 475-484, 486-497, 499-529, 531-565

**Examples:**
- Effect syncs `selectedProviderIdRaw` from localStorage on mount
- Effect syncs from `initialProviderId` prop
- Effect resets `selectedModel` when `availableModels` changes
- Effect resets `reasoningLevel` when model capabilities change
- Effect resets `environmentSelection` when scope changes

**Fix:** Replace with a `useReducer` that validates state transitions in the reducer function. Derive computed values with `useMemo`. Extract localStorage persistence to a dedicated hook.

### Moderate: State sync from props

**`HireManagerModal.tsx` (lines 55-62)** — Effect resets selected provider when provider list changes. Should derive the selection during render:
```typescript
// Instead of useEffect that sets state, compute during render
const effectiveProviderId = providers.some(p => p.id === selectedProviderId)
  ? selectedProviderId
  : resolvePreferredManagerProviderId(providers);
```

### Moderate: Manual debounce

**`usePromptMentions.ts` (lines 58-71)** — Manual `setTimeout` debounce pattern. Modern React offers `useDeferredValue` for this. Alternatively, a shared `useDebouncedValue` hook or `lodash-es/debounce` would be cleaner.

### Acceptable effects (no action needed)

- `useWebSocket.ts` — WebSocket subscription lifecycle (legitimate external system sync)
- `useHostDaemon.ts` — uses `useSyncExternalStore` correctly
- `useVoiceInput.ts` — MediaRecorder cleanup
- `useThreadTimelineController.ts` — DOM scroll position tracking
- `useGitDiffFileRenderQueue.ts` — timer cleanup for render batching

---

## 3. Jotai and React Query Patterns

### Jotai: Well-organized

All atoms in a single file (`lib/atoms.ts`, 61 lines). Consistent `*Atom` suffix. Proper derived atoms. Clean separation between jotai (global singleton state like host daemon port, system config) and React Query (server state). No issues.

### React Query: Mostly good, one issue

**Query keys** — Consistent hierarchical pattern: `["entity", id, ...params]`. Good.

**Stale times** — Reasonable values scaled by data volatility:
- 60s: models, providers (slow-changing)
- 30s: projects
- 10s: thread lists
- 5s: thread detail, git diff

**Placeholder data** — Good use of `resolveThreadPlaceholder()` and friends to reduce loading flickers.

**Issue: Broad invalidation in `useRequestEnvironmentAction()`** (`useApi.ts:1069-1073`)

```typescript
// Current: invalidates ALL threads, ALL timelines
queryClient.invalidateQueries({ queryKey: ["thread"] });
queryClient.invalidateQueries({ queryKey: ["threads"] });
queryClient.invalidateQueries({ queryKey: ["threadTimeline"] });
queryClient.invalidateQueries({ queryKey: ["threadWorkStatus"] });
```

Should invalidate specific IDs only:
```typescript
queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
queryClient.invalidateQueries({ queryKey: ["threadTimeline", threadId] });
```

### When to use what (current practice)

| Concern | Tool | Assessment |
|---------|------|------------|
| Server entity data | React Query | Correct |
| Global config (host port, system config) | Jotai async atoms | Correct |
| Local UI state (collapse, selection) | useState / localStorage | Correct, but localStorage pattern needs abstraction |
| Form state | useState | Correct for simple forms |
| Complex multi-field form state | useState + 11 effects | Incorrect — should use useReducer |

---

## 4. Component Prop Design

### Problematic: PromptBox (20+ props)

```typescript
// Current: 20+ flat props
interface PromptBoxProps {
  id, value, onChange, onSubmit, placeholder, className,
  footerStart, isSubmitting, submitDisabled, submitTitle, submitMode,
  isRunning, onStop, autoFocus,
  mentionSuggestions, mentionSearchScope, mentionLoading, mentionError, onMentionQueryChange,
  attachments, isAttaching, attachmentError, onAttachFiles, onRemoveAttachment,
  zenModeLayout, zenModeStorageKey, zenModeResetKey, resetZenModeOnSubmit,
  attachmentProjectId
}
```

**Recommended:** Group into config objects:
```typescript
interface PromptBoxProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submission: SubmissionConfig;   // isSubmitting, disabled, title, mode, isRunning, onStop
  mentions?: MentionConfig;       // suggestions, searchScope, loading, error, onQueryChange
  attachments?: AttachmentConfig; // items, isAttaching, error, onAttach, onRemove, projectId
  zenMode?: ZenModeConfig;        // layout, storageKey, resetKey, resetOnSubmit
  // ...remaining simple props
}
```

### Problematic: PromptExecutionControls (20 props)

Similar issue — 20 flat props for provider selection, model selection, service tier, reasoning level, and sandbox mode. Should group into `ProviderConfig`, `ModelConfig`, etc.

### Acceptable

- `ThreadActionsMenu` (14 props) — semantically grouped action callbacks, reasonable
- `HireManagerModal` (4 props) — clean
- `AppHeader` (6 props) — clean

### Function argument style

**Backend packages:** Excellent. All functions use typed objects: `queueCommand(db, notifier, input: QueueCommandInput)`. No positional argument sprawl.

**CLI commands:** Options are already objects from Commander, but some internal helpers like `buildSpawnEnvironment()` take multiple string arguments that could be grouped.

---

## 5. Missing Shared Abstractions

Patterns repeated 3+ times without a shared implementation.

### HIGH: localStorage boilerplate (8+ occurrences)

Every localStorage interaction repeats the same try-catch-parse-validate pattern:
```typescript
try {
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return DEFAULT;
  const parsed = JSON.parse(raw);
  // ... type validation ...
} catch { return DEFAULT; }
```

**Found in:** `ProjectList.tsx`, `AppLayout.tsx`, `PromptBox.tsx`, `useTheme.ts`, `usePromptDraftStorage.ts`, `auto-archive-preferences.ts`, `useThreadCreationOptions.ts` (6 storage keys), `project-scoped-storage.ts`

**Fix:** Create a `useLocalStorage<T>(key, defaultValue, validator?)` hook. Libraries like `@uidotdev/usehooks` provide battle-tested implementations, or write a simple one.

### HIGH: Dialog state management (5+ occurrences)

Every modal/dialog manages the same state:
```typescript
const [target, setTarget] = useState<Entity | null>(null);
// open={target !== null}
// onOpenChange -> setTarget(null)
const [validationMessage, setValidationMessage] = useState<string | null>(null);
```

**Found in:** `ThreadDeleteDialog`, `ThreadRenameDialog`, `ThreadGitActionDialog`, `ProjectList` (archive dialog), `HireManagerModal`

**Fix:** Create `useDialogState<T>()` hook that returns `{ target, open, onOpen, onClose }`. Consider a `ConfirmationDialog` component for the common confirm-action pattern.

### MEDIUM: CLI table rendering (4 files, identical pattern)

All CLI tables use the same pattern: calculate max column widths with `Math.max(...items.map(i => i.field.length))`, pad with `padEnd(width)`, join with `"  "`, print header + separator + rows.

**Found in:** `project.ts:173-200`, `provider.ts:57-107`, `manager.ts:182-241`, `thread.ts:1053-1089`

**Fix:** Extract a `printTable(columns, rows)` utility. Or use a library like `cli-table3` or `tty-table` (though the current approach is lightweight and a shared function would suffice).

### MEDIUM: Duration formatting (2 implementations)

- `@bb/core-ui/format-helpers.ts:23-31` — `durationToString()`
- `apps/app/src/components/messages/rows/shared.tsx:123-131` — `formatCompactDuration()`

Two nearly identical formatters with slightly different rounding. The app-local one should import from core-ui or core-ui should expose both variants.

### MEDIUM: Empty state rendering (6+ occurrences)

Ad-hoc "no items" messages scattered across components with inconsistent styling.

**Fix:** Create a shared `EmptyState` component: `<EmptyState message="No threads" icon={Inbox} />`.

### MEDIUM: Validation error display (3+ occurrences)

Same pattern in every form dialog:
```typescript
{validationMessage && <p className="text-sm text-destructive">{validationMessage}</p>}
```

**Fix:** Extract a `FormError` component or incorporate into a shared `FormField` component.

### LOW: Error message extraction

`api.ts` has `deriveHttpErrorMessage()`, `@bb/core-ui` has `extractErrorMessage()`, and some components still do `error instanceof Error ? error.message : "Unknown error"` inline.

---

## 6. Naming Drift and Stale References

### Critical: ThreadWorkStatus → WorkspaceStatus (72+ stale references)

The domain type was renamed from `ThreadWorkStatus` to `WorkspaceStatus`, but variable names, function names, file names, and query keys throughout the app still use the old convention.

**Type definition (correct):**
- `packages/domain/src/thread.ts:58` — `export type WorkspaceStatus`

**Stale variable names:**
- `views/ThreadDetailView.tsx:426-427` — `threadWorkStatusError`, `resolvedThreadWorkStatus`
- `views/ThreadFollowUpComposer.tsx:154, 220` — `resolvedThreadWorkStatus`

**Stale function names:**
- `lib/thread-work-status.ts:26` — `threadWorkStatusLabel()`
- `lib/thread-work-status.ts:94` — `getThreadGitStatusDisplay()`
- `lib/thread-work-status.ts:194` — `threadWorkStatusDescription()`
- `lib/thread-work-status.ts:238` — `threadWorkStatusVariant()`

**Stale file name:**
- `lib/thread-work-status.ts` — should be `workspace-status-helpers.ts` or similar

**Stale query key constants:**
- `hooks/useApi.ts:46` — `THREAD_WORK_STATUS_QUERY_KEY = "threadWorkStatus"` (actually used for environment work status)
- `hooks/useApi.ts:83` — `resolveThreadWorkStatusPlaceholder()` (operates on environment data)

### Moderate: Dead package still in tree

`@bb/env-daemon-contract` is documented as dead in `plans/rebuild.md:57` ("nothing imports it, delete when convenient") but the package directory still exists.

### Moderate: Stale "env-daemon" references in comments

15+ comments in `@bb/agent-runtime` reference "env-daemon" instead of "host-daemon":
- `agent-runtime/src/claude-code/bridge/bridge.ts:7`
- `agent-runtime/src/claude-code/adapter.ts:370`
- `agent-runtime/src/codex/adapter.ts:62`
- `agent-runtime/src/shared/bridge-tool-calls.ts:5-43`
- `agent-runtime/src/pi/bridge/sdk-session.ts:101`

### Minor: CLI function naming

- `helpers.ts:24` — `resolveThreadIdOrSelf()` throws on invalid input. "Resolve" implies lookup; "require" or "parse" would be more accurate.
- `context-env.ts:3` — `normalizeValue()` is too generic for a function that trims and converts empty strings to undefined.

---

## 7. Reinvented Wheels / Library Opportunities

Patterns where well-tested libraries could replace custom code.

### MEDIUM: Custom ANSI color formatting

**File:** `packages/core-ui/src/format-timeline-text.ts:22-37`

Manual ANSI escape codes:
```typescript
function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[22m` : text;
}
function cyan(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[39m` : text;
}
```

**Replace with:** `chalk` (already standard in Node CLIs) or `colorette` (tiny, no deps). Both handle color support detection automatically.

### MEDIUM: Custom git execution wrapper

**File:** `packages/workspace/src/git.ts:53-85`

Manual `child_process.execFile` wrapper with `promisify`, custom error handling, buffer management.

**Replace with:** `execa` — better error messages, timeout handling, stream management, and shell option safety. Currently the workspace package has zero runtime dependencies besides `@bb/domain`, so adding `execa` would be the first, but it's a well-maintained essential.

### LOW: Custom debounce in React hooks

**Files:** `usePromptMentions.ts:58-71`, `useWebSocket.ts:107-192`

Manual `setTimeout` debounce with timer tracking.

**Options:**
- React 19's `useDeferredValue` for the mention query case
- `lodash-es/debounce` if a proper debounce with maxWait is needed (for the WebSocket invalidation case)
- A shared `useDebouncedValue(value, delay)` hook (small enough to own)

### LOW: Custom JSON-RPC timeout

**File:** `packages/agent-runtime/src/runtime.ts:16-55`

Manual pending-request map with timeout timers.

**Replace with:** Unlikely worth it — this is tightly coupled to the child process IPC pattern. A library like `json-rpc-2.0` would add more abstraction than value here.

### NOT RECOMMENDED to replace

- **ID generation** (`packages/db/src/ids.ts`) — already uses `nanoid`, just wraps it with typed prefixes. Good.
- **WebSocket reconnection** (`lib/ws.ts`) — already uses `partysocket`. The wrapper is domain-specific. Good.
- **Zod validation** — already in use everywhere. Good.
- **Logging** — Pino. Good.
- **Config** — envsafe. Good.
- **ORM** — Drizzle. Good.

---

## 8. CLI-Specific Issues

### Error handling boilerplate (28 occurrences)

Every command action wraps its body in:
```typescript
try {
  // ... command logic ...
} catch (err) {
  console.error(`Error: ${getErrorMessage(err)}`);
  process.exit(1);
}
```

**Fix:** Create a `wrapAction(fn)` higher-order function:
```typescript
function wrapAction<T extends (...args: any[]) => Promise<void>>(fn: T): T {
  return (async (...args) => {
    try { await fn(...args); }
    catch (err) { console.error(`Error: ${getErrorMessage(err)}`); process.exit(1); }
  }) as T;
}
```

### Custom CLI argument parsers (4 functions)

`thread.ts:120-154` has four manual parse functions (`parseRecentEventsCount`, `parseThreadStatusEventMode`, `parseThreadWaitTimeoutSeconds`, `parseThreadWaitPollIntervalMs`). Each manually validates and throws. Fine for now, but if more validators are added, consider using Zod coerce schemas.

### Missing error context

When API calls fail, the CLI shows generic "Error: <message>" without request context. Consider including the operation name: "Failed to archive thread: <message>".

---

## 9. Backend Package Assessment

The backend packages are in good shape. Brief notes:

### @bb/db — Excellent
- 12 files, 41 functions, consistent `fn(db, notifier, input: TypedObject)` pattern
- No positional argument sprawl
- Good naming: `createX`, `getX`, `listX`, `updateX`, `deleteX`
- State machine pattern in `transitionThreadStatus` with explicit allowed-transitions map
- 59 tests passing

### @bb/workspace — Excellent
- Clean three-tier architecture: git ops → workspace class → provisioning
- All methods use options objects
- Good discriminated union for `ProvisionWorkspaceOpts` (unmanaged | worktree | clone)
- Minor: `createWorktree` and `createClone` in `provisioning.ts` share similar structure — could extract common flow

### @bb/domain — Pristine
- Clean Zod schemas, proper discriminated unions, consistent naming
- `*Schema` for Zod objects, `*Values` for enum arrays, PascalCase for types

### @bb/server-contract and @bb/host-daemon-contract — Excellent
- Type-safe route definitions, proper request/response schemas
- All use Zod with discriminated unions and `.refine()` for cross-field validation

### @bb/config — Clean
- envsafe with scoped exports per consumer

### @bb/logger — Clean
- Pino with component-based log routing, proper rotation

### @bb/core-ui — Good, one issue
- `unknown-helpers.ts` exports `toRecord()` and `getStringField()` for defensive parsing. Per existing project guidelines, these should not be used on typed data. Verify no typed-data callers exist.

---

## 10. Dead Code and Cleanup

| Item | Location | Action |
|------|----------|--------|
| `@bb/env-daemon-contract` package | `packages/env-daemon-contract/` | Delete — documented as dead, nothing imports it |
| "env-daemon" comments | 15+ in `@bb/agent-runtime` | Update to "host-daemon" |
| `plans/extensions-system.md` | `plans/` | Delete or defer — documented as out of scope |
| `thread-work-status.ts` filename | `apps/app/src/lib/` | Rename to match domain type |

---

## Suggested Improvements by Priority

### P0 — High impact, addresses real maintenance pain

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | **Split `ThreadDetailView.tsx`** (1,747 lines) into focused components + hooks | 1 file → ~5 files | Medium |
| 2 | **Replace 11 useEffect chains** in `useThreadCreationOptions.ts` with `useReducer` | 1 file | Medium |
| 3 | **Rename `ThreadWorkStatus` → `WorkspaceStatus`** across 72+ variable/function/file references | ~8 files | Small (find-replace) |
| 4 | **Create `useLocalStorage<T>` hook** to replace 8+ copy-pasted localStorage patterns | 1 new hook, ~8 files updated | Small |
| 5 | **Split CLI `thread.ts`** (1,180 lines) into submodules | 1 file → ~6 files | Small |

### P1 — Good cleanup, prevents drift

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 6 | **Extract CLI `printTable()` utility** to replace 4 duplicated table renderers | 4 files | Small |
| 7 | **Extract CLI `wrapAction()` error handler** to replace 28 identical try/catch blocks | All CLI command files | Small |
| 8 | **Refactor `PromptBox` props** into grouped config objects | 1 component + callers | Medium |
| 9 | **Fix broad React Query invalidation** in `useRequestEnvironmentAction()` | 1 file | Tiny |
| 10 | **Create `useDialogState<T>` hook** for 5+ modal dialogs | 1 new hook, ~5 files | Small |
| 11 | **Consolidate duration formatting** — delete app-local copy, use core-ui | 2 files | Tiny |
| 12 | **Delete `@bb/env-daemon-contract`** package | 1 directory | Tiny |

### P2 — Nice to have, lower urgency

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 13 | **Replace manual ANSI escapes** with `chalk` or `colorette` | 1 file in core-ui | Small |
| 14 | **Replace `child_process.execFile`** in workspace with `execa` | 1 file | Small |
| 15 | **Create shared `EmptyState` component** | 1 new component, ~6 callsites | Small |
| 16 | **Create shared `FormError` component** for validation messages | 1 new component, ~3 callsites | Tiny |
| 17 | **Update stale "env-daemon" comments** in agent-runtime | ~5 files | Tiny |
| 18 | **Split `ProjectList.tsx`** (838 lines) into project list + thread list sections | 1 file → ~3 files | Medium |
| 19 | **Replace manual debounce** in `usePromptMentions` with `useDeferredValue` | 1 file | Tiny |
| 20 | **Improve CLI error messages** with operation context | All CLI commands | Small |

### Not recommended

| Item | Reason |
|------|--------|
| Replace nanoid wrapping | Already using nanoid, typed wrappers add value |
| Replace partysocket wrapper | Already using partysocket, domain wrapper is thin and appropriate |
| Add DI framework | Explicit dependency passing is working well |
| Add form library (react-hook-form) | Only 2-3 simple forms, not worth the dep |
| Add CLI framework beyond Commander | Commander is appropriate for this CLI's complexity |
