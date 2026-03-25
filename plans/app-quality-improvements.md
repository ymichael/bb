# App Quality Improvements

Actionable plan for `apps/app` code quality, maintainability, and consistency. Can run concurrently with CLI improvements.

**Important:** Line numbers reference the code as of 2026-03-25. Grep for identifiers rather than trusting line numbers, as earlier steps may shift them.

---

## 1. Fix naming drift: ThreadWorkStatus → WorkspaceStatus

Rename all variable names, function names, file names, query keys, and constants that still use the old `ThreadWorkStatus` convention. The domain type is already `WorkspaceStatus` — this is purely identifier renaming, no type changes. TypeScript doesn't catch this because the type annotations are correct; only the identifier names are stale.

### Files to update

**Rename files:**
- `src/lib/thread-work-status.ts` → `src/lib/workspace-status.ts`
- `src/lib/thread-work-status.test.ts` → `src/lib/workspace-status.test.ts`

**`src/hooks/useApi.ts`** — grep for all `threadWorkStatus` and `THREAD_WORK_STATUS` occurrences:
- `THREAD_WORK_STATUS_QUERY_KEY` → `WORKSPACE_STATUS_QUERY_KEY`
- `resolveThreadWorkStatusPlaceholder()` → `resolveWorkspaceStatusPlaceholder()`
- All query key string literals `"threadWorkStatus"` → `"workspaceStatus"` (used in `removeQueries` and `invalidateQueries` calls — grep to find all, don't trust line numbers)

**`src/lib/workspace-status.ts` (after rename):**
- `threadWorkStatusLabel()` → `workspaceStatusLabel()`
- `getThreadGitStatusDisplay()` → `getGitStatusDisplay()`
- `threadWorkStatusDescription()` → `workspaceStatusDescription()`
- `threadWorkStatusVariant()` → `workspaceStatusVariant()`
- `threadWorktreeCleanLabel()` — review this name too, it may be fine as-is since it's worktree-specific

**`src/views/ThreadDetailView.tsx`:**
- `threadWorkStatusError` → `workspaceStatusError`
- `resolvedThreadWorkStatus` → `workspaceStatus`
- `showThreadWorkspaceStatus` → `showWorkspaceStatus`

**`src/views/ThreadFollowUpComposer.tsx`:**
- `resolvedThreadWorkStatus` prop → `workspaceStatus` (in interface definition and all usages)

**`src/components/shared/WorkspaceStatusIndicator.tsx`:**
- Update import path from `thread-work-status` → `workspace-status`

**`src/hooks/useApi.test.ts`:**
- Update query key strings in test assertions

**`src/lib/workspace-status.test.ts` (after rename):**
- Update imports and describe block name

### Validation
- `pnpm exec turbo run typecheck --filter=@bb/app`
- `pnpm exec turbo run test --filter=@bb/app`
- Grep for any remaining `threadWorkStatus` (case-insensitive) to confirm nothing was missed

---

## 2. Replace localStorage patterns with jotai atomWithStorage

Replace hand-rolled localStorage read/write/parse patterns with `atomWithStorage` from `jotai/utils`. Already depends on jotai. This eliminates try-catch boilerplate and provides cross-tab sync.

### Targets

**`src/hooks/useThreadCreationOptions.ts` (6 storage keys):**
- `bb.promptbox.model`, `bb.promptbox.service-tier`, `bb.promptbox.reasoning`, `bb.promptbox.sandbox`, `bb.promptbox.environment`, `bb.promptbox.provider`
- These are project-scoped (key includes project ID). Use `atomFamily` + `atomWithStorage` keyed by project ID.

**`src/hooks/useTheme.ts`:**
- Theme preference persisted to localStorage

**`src/components/layout/ProjectList.tsx`:**
- Collapsed project IDs set (stored as JSON array, converted to/from Set)

**`src/components/layout/AppLayout.tsx`:**
- Layout preferences (sidebar width)

**`src/lib/auto-archive-preferences.ts`:**
- Auto-archive settings (JSON with defensive parsing — preserve validation via custom `storage` option)

**`src/components/promptbox/PromptBox.tsx`:**
- Zen mode localStorage (`bb.promptbox.zen-mode.*` keys)

### Excluded targets

**`src/hooks/usePromptDraftStorage.ts`** — Do NOT migrate. Uses `useSyncExternalStore` with an in-memory cache layer, versioned keys, and custom serialization (text + attachments). Fundamentally different architecture that doesn't map to `atomWithStorage`.

### Key implementation notes

**Raw string storage:** Several current values are stored as raw strings (e.g., `"medium"`, `"claude-sonnet-4-20250514"`), not JSON. `atomWithStorage` defaults to JSON serialization, which would store `"medium"` as `"\"medium\""`. Use a custom `storage` adapter for string-valued atoms:

```typescript
import { createJSONStorage } from "jotai/utils";

const rawStringStorage = createJSONStorage<string>(() => localStorage, {
  // Override to skip JSON.parse/stringify for plain strings
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
});
```

**Project-scoped key format:** Current keys use `getProjectScopedStorageKey()` which produces keys like `bb.promptbox.model-<encodedProjectId>-1`. The `atomFamily` factory must match this format to preserve existing user preferences. Do NOT change the key format — use the existing helper:

```typescript
export const projectScopedAtom = <T>(baseKey: string, defaultValue: T) =>
  atomFamily((projectId: string) =>
    atomWithStorage<T>(getProjectScopedStorageKey(baseKey, projectId), defaultValue)
  );
```

**Set-valued atoms (ProjectList collapsed IDs):** `atomWithStorage` handles JSON serialization. Store as an array, convert to Set at the consumption site, or use a custom storage adapter.

### Validation
- All existing tests still pass
- Manual: change a preference, refresh page, verify it persists
- Manual: switch projects, verify per-project preferences load correctly
- Manual: verify existing stored preferences survive the migration (key format unchanged)

---

## 3. Eliminate useEffect chains in useThreadCreationOptions

Replace 11 cascading useEffect hooks with a **derive-more, store-less** pattern. The core insight: effects that "validate and reset" state when options change are derivations disguised as effects.

### Current problem

```
User selects provider → effect syncs model list → effect validates selected model →
effect validates reasoning level → effect validates service tier → ...
```

Each effect sets state, triggering the next. Hard to reason about, potential for stale closures and render cascading.

### Target pattern

Store only the user's **raw selections** (what they clicked) in `atomWithStorage` atoms from step 2. Derive **effective values** (what to actually use given current capabilities) with `useMemo`. No cascading effects.

```typescript
// Raw user selections (stored in atomWithStorage atoms from step 2)
const [rawProviderId, setRawProviderId] = useAtom(providerAtom(projectId));
const [rawModel, setRawModel] = useAtom(modelAtom(projectId));
const [rawReasoningLevel, setRawReasoningLevel] = useAtom(reasoningAtom(projectId));

// Derive effective values — no effects needed
const effectiveModel = useMemo(() => {
  if (availableModels.some(m => m.model === rawModel)) return rawModel;
  return availableModels.find(m => m.isDefault)?.model ?? availableModels[0]?.model ?? "";
}, [availableModels, rawModel]);

const effectiveReasoningLevel = useMemo(() => {
  if (reasoningOptions.some(o => o.value === rawReasoningLevel)) return rawReasoningLevel;
  return activeModel?.defaultReasoningEffort ?? reasoningOptions[0]?.value ?? "medium";
}, [reasoningOptions, rawReasoningLevel, activeModel]);
```

### The `touched` state

The current code tracks which fields the user has manually changed via a `touched` map in the reducer. The `sync-untouched` action (lines 499-529) uses this to selectively update fields when thread-scope options change from the server without overwriting user manual changes.

In the new pattern, `touched` is replaced by comparing the raw atom value against the initial value:
- If the user hasn't changed a field, the atom still holds the initial value → derivation uses server value
- If the user has changed it, the atom holds their explicit choice → derivation respects it

Alternatively, keep a simple `touchedFields: Set<string>` in local state (not persisted) that the thread-scope initialization effect checks before overwriting.

### Hydration guard

The current `hydratedStorageKey` guard prevents writing stale values before localStorage hydration completes. With `atomWithStorage`, hydration is handled by jotai internally — the atom reads from storage on initialization. This guard becomes unnecessary.

### Effects that remain (legitimate)

**Thread scope initialization (1 effect):** When `scope === "thread"`, initialize raw values from `options.initial*` props. Keyed on `options?.resetKey`. Must respect `touched` tracking — only overwrite fields the user hasn't manually changed.

### Effects that are eliminated

| Current effect | Replacement |
|---|---|
| Sync provider from localStorage | `atomWithStorage` handles this |
| Sync from initialProviderId | Thread scope initialization effect |
| Persist provider to localStorage | `atomWithStorage` handles this |
| Reset model when available models change | `useMemo` → `effectiveModel` |
| Reset service tier when not supported | `useMemo` → `effectiveServiceTier` |
| Reset reasoning when options change | `useMemo` → `effectiveReasoningLevel` |
| Reset environment when options change | `useMemo` → `effectiveEnvironment` |
| Hydrate from storage on scope change | `atomWithStorage` handles this |
| Sync untouched fields from thread options | Thread scope initialization effect (with touched check) |
| Persist all fields to localStorage | `atomWithStorage` handles this |

**Result:** 11 effects → 1 effect (thread scope initialization with touched check) + `useMemo` derivations + `atomWithStorage` for persistence.

### Validation
- Existing `useThreadCreationOptions` tests pass
- Manual: switch projects, verify remembered selections per project
- Manual: switch provider, verify model falls back to valid option
- Manual: open thread with initial options, verify they populate correctly
- Manual: in thread scope, manually change model, then trigger an options update — verify your manual choice is preserved (touched tracking)

---

## 4. Split ThreadDetailView.tsx (1,747 lines)

### Extract custom hooks

Place extracted hooks in `src/views/` alongside the view (they're view-specific, not reusable app-wide hooks).

**`useThreadDebugView(threadId)`** — manages debug view toggle state and manager workspace file fetching. ~40 lines.

**`useThreadMergeBase(thread, environment)`** — merge base branch selection state, candidate computation, URL sync. ~50 lines. Needs `thread` and `environment` as inputs (from React Query hooks in parent).

**`useThreadFollowUpTracking(threadId, timeline)`** — pending follow-up tracking, acknowledgment state. ~40 lines. Needs `timeline` data as input.

**`useThreadReadTracking(threadId, timeline)`** — mark-as-read side effect based on timeline updates. ~20 lines.

### Extract sub-components

Place in `src/views/` or `src/components/thread/` as appropriate.

**`ThreadDetailHeader`** — breadcrumbs, title, copy button, panel toggle, actions menu. Currently ~100 lines of JSX in the render.

**`ThreadDetailPromptArea`** — the prompt box + follow-up composer + queued message display. Encapsulates the prompt-related state wiring.

**`ThreadDetailSecondaryContent`** — the resizable panel group wrapping the secondary panel (git diff, workspace status, etc.).

### What stays in ThreadDetailView

Route param extraction, data fetching orchestration (React Query hooks), derived state computation, callback definitions, and composition of the sub-components. Realistic target: **400-500 lines** (the derived state and callbacks are substantial). This is still a 3-4x reduction.

### Validation
- `pnpm exec turbo run typecheck --filter=@bb/app`
- All existing tests pass
- Manual: full thread lifecycle still works (create, send, view timeline, git diff, archive)

---

## 5. Restructure PromptBox and PromptExecutionControls props

Group the 20+ flat props into typed config objects in both components.

### PromptBox — target interface

File: `src/components/promptbox/PromptBox.tsx` (not `shared/` — the actual path is `promptbox/`)

```typescript
interface PromptBoxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  footerStart?: ReactNode;

  submission: {
    isSubmitting: boolean;
    disabled: boolean;
    title: string;
    mode: "send" | "tell";
    isRunning: boolean;
    onStop: () => void;
  };

  mentions?: {
    suggestions: PromptMentionSuggestion[];
    searchScope: MentionSearchScope;
    isLoading: boolean;
    isError: boolean;
    onQueryChange: (query: string | null) => void;
  };

  attachments?: {
    items: PromptAttachment[];
    isAttaching: boolean;
    error: string | null;
    onAttach: (files: FileList) => void;
    onRemove: (id: string) => void;
    projectId: string;
  };

  zenMode?: {
    layout: "default" | "zen";
    storageKey: string;
    resetKey?: string;
    resetOnSubmit: boolean;
  };
}
```

### PromptExecutionControls — target interface

File: `src/components/promptbox/PromptExecutionControls.tsx` (also 20 props)

Group into:
```typescript
interface PromptExecutionControlsProps {
  provider: {
    options: readonly PromptOption<string>[];
    selectedId: string;
    onChange: (value: string) => void;
    hasMultiple: boolean;
    displayName: string;
    readOnly: boolean;
  };
  model: {
    active: { model: string } | null;
    selected: string;
    options: readonly PromptOption<string>[];
    onChange: (value: string) => void;
  };
  serviceTier?: { /* ... */ };
  reasoning?: { /* ... */ };
  sandbox?: { /* ... */ };
}
```

### Approach

1. Define the sub-interfaces alongside the component props
2. Update components to destructure from grouped props
3. Update all callsites (likely 2-3 per component)

### Validation
- Typecheck passes
- Manual: all prompt features work (mentions, attachments, zen mode, submission, execution controls)

---

## 6. Fix broad React Query invalidation

**`src/hooks/useApi.ts`** in `useRequestEnvironmentAction()`:

```typescript
// Current: invalidates ALL threads/timelines globally
queryClient.invalidateQueries({ queryKey: ["thread"] });
queryClient.invalidateQueries({ queryKey: ["threads"] });
queryClient.invalidateQueries({ queryKey: ["threadTimeline"] });
queryClient.invalidateQueries({ queryKey: ["threadWorkStatus"] });  // also renamed per step 1
queryClient.invalidateQueries({ queryKey: ["status"] });
```

Note: there are 5 invalidation calls, not 4 — the `["status"]` one may be intentionally broad. Review whether it needs to be targeted too.

Replace with targeted invalidation. The mutation knows the `environmentId` — invalidate queries for specific entities. The thread list invalidation (`["threads"]`) is acceptable since it's a list query, but `["thread"]` and `["threadTimeline"]` without an ID prefix hits every cached thread.

### Validation
- Perform an environment action (commit, promote), verify the affected thread's data refreshes
- Verify unrelated threads' data is NOT refetched (check network tab)

---

## 7. Smaller improvements

### Consolidate duration formatting
- Compare `formatCompactDuration()` in `src/components/messages/rows/shared.tsx` with `durationToString()` in `@bb/core-ui`. If they differ meaningfully, add a compact variant to core-ui. Then delete the app-local copy and import from core-ui.

### Create shared EmptyState component
- Simple component: `<EmptyState message="No threads" icon={Inbox} />`
- Replace ad-hoc "no items" rendering in `ProjectList.tsx`, `WorkspaceChangesList.tsx`, etc.

### Create shared FormError component
- `<FormError message={validationMessage} />` — consistent `text-sm text-destructive` styling
- Replace inline validation rendering in `ThreadRenameDialog`, `ThreadGitActionDialog`, `HireManagerModal`

### Create useDialogState hook
- `useDialogState<T>()` → `{ target, isOpen, onOpen, onClose }`
- Replace 5+ identical `useState<T | null>(null)` patterns in dialog components

### Fix HireManagerModal useEffect
- Lines 55-62: effect resets selected provider when provider list changes
- Replace with derived value during render:
  ```typescript
  const effectiveProviderId = providers.some(p => p.id === selectedProviderId)
    ? selectedProviderId
    : resolvePreferredManagerProviderId(providers);
  ```

### Install `usehooks-ts` and replace hand-rolled browser API hooks

Install `usehooks-ts` (5.2 KB gzipped, tree-shakeable). Replace 4 hand-rolled patterns:

**`useMediaQuery`** — replace `src/hooks/useMobile.ts` entirely (~20 lines):
```typescript
// Before: 20-line hand-rolled hook with matchMedia + addEventListener
// After:
import { useMediaQuery } from "usehooks-ts";
export function useMobile() { return useMediaQuery("(max-width: 767px)"); }
```

**`useResizeObserver`** — replace 3 hand-rolled ResizeObserver setups (~45 lines total):
- `src/views/useResponsiveGitDiffPanelDisplay.ts` (lines 74-86)
- `src/views/useThreadTimelineController.ts` (lines 327-365, 369-390)

**`useIntersectionObserver`** — replace hand-rolled `useIsStuck` in `src/views/ThreadSecondaryPanel.tsx` (lines 179-201, ~22 lines)

**`useDebounceValue`** — replace manual setTimeout debounce in `src/hooks/usePromptMentions.ts` (lines 55-71, ~17 lines)

**Do NOT use `useLocalStorage` from this library** — that layer is handled by jotai `atomWithStorage` (step 2). Skip `useDarkMode` too — existing `useTheme` with `useSyncExternalStore` already does more.

---

## Execution order

Steps 1-2 are independent and can be done first. Step 3 builds on step 2 (uses atomWithStorage atoms). Steps 4-7 are independent of each other and steps 1-3.

```
1 (naming drift)  ─────────────────────────────────┐
2 (atomWithStorage) → 3 (eliminate effect chains)   ├→ done
4 (split ThreadDetailView)                          │
5 (PromptBox + PromptExecutionControls props)       │
6 (query invalidation)                              │
7 (smaller items)  ────────────────────────────────-┘
```
