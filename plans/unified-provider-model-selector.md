# Unified Provider+Model Selector with Provider Icons

## Goal

Merge the two separate Provider and Model dropdowns in the prompt box footer into a single combined dropdown showing `[ProviderIcon] ModelName`, with models grouped by provider. Inspired by terragon-oss's pattern.

## Context

The prompt box footer currently shows **two separate dropdowns** — one for Provider and one for Model. This is clunky: takes horizontal space, text-only labels are hard to scan. Terragon OSS solves this with a single combined dropdown showing `[ProviderIcon] ModelName`, with models grouped by provider. We'll adopt this pattern.

## Scope

- Create 3 SVG provider icon components (OpenAI, Anthropic, Pi)
- Create a `getProviderIconInfo()` helper mirroring `environment-icon.ts`
- Build a new `PromptProviderModelPicker` that replaces both the provider picker and model picker
- Update `PromptExecutionControls` and callers
- Add provider icons to `HireManagerModal`
- Delete the now-unused `PromptModelPicker`

## Implementation Steps

### Step 1: Create provider icon SVG components

Create `apps/app/src/components/icons/`:
- `OpenAiIcon.tsx` — OpenAI logomark, `fill="currentColor"`, viewBox-based
- `AnthropicIcon.tsx` — Anthropic "A" mark, same contract
- `PiIcon.tsx` — Pi geometric mark from pi.dev, adapted to `currentColor`
- `index.ts` — barrel export

SVG sources: OpenAI and Anthropic from terragon-oss (`/tmp/git-references/terragon-labs/terragon-oss/apps/www/src/components/icons/`), Pi from pi.dev/logo.svg (rescaled to viewBox 0 0 24 24).

### Step 2: Create `getProviderIconInfo` helper

**`apps/app/src/lib/provider-icon.ts`** — mirrors `environment-icon.ts` pattern:
```ts
export function getProviderIconInfo(providerId: string): ProviderIconInfo | undefined
```
Exhaustive switch over closed_internal IDs: `codex` → OpenAiIcon, `claude-code` → AnthropicIcon, `pi` → PiIcon.

### Step 3: Enrich `providerOptions` with icons

In `apps/app/src/hooks/usePromptModelReasoning.ts`, update the `providerOptions` memo to attach `icon` from `getProviderIconInfo(p.id)?.icon`. The `PromptOption` interface already has an optional `icon` field — no type changes needed.

### Step 4: Create `PromptProviderModelPicker` component

**`apps/app/src/components/promptbox/PromptProviderModelPicker.tsx`**

Props: provider state + model state + fast mode state (combines what `PromptOptionPicker` and `PromptModelPicker` accepted).

**Trigger**: `[ProviderIcon] [Zap?] ModelLabel [ChevronDown]` — same styling as current pickers.

**Dropdown content** (using existing Radix `DropdownMenuGroup`/`DropdownMenuLabel`/`DropdownMenuSeparator`):
- When `hasMultipleProviders`: show provider group headers with icons. Active provider's models shown as selectable items. Other provider headers shown as clickable items to switch provider.
- When single provider: flat model list, no headers.
- Fast mode toggle at bottom (when supported).

**Provider switch behavior**: clicking a non-active provider header calls `onSelectedProviderChange`, uses `event.preventDefault()` to keep dropdown open while models refetch. Show "Loading..." placeholder when modelOptions is empty after a switch.

**Read-only mode** (`providerReadOnly`): provider headers are non-interactive labels, only current provider's models shown.

### Step 5: Update `PromptExecutionControls`

Replace the two conditional blocks (provider picker + model picker) with a single `PromptProviderModelPicker`. Keep the `PromptOptionDisplay` fallback for when `supportsModelList` is false but provider needs to be shown.

Export the styling constants (`PROMPT_OPTION_BASE_CLASS_NAME` etc.) from `PromptOptionPicker.tsx` so the new component can reuse them.

### Step 6: Wire up `ThreadFollowUpComposer`

Pass `providerOptions` and `selectedProviderId` through to `PromptExecutionControls` (in addition to existing props). The caller chain already has this data from `usePromptModelReasoning`.

### Step 7: Update `HireManagerModal`

Import `getProviderIconInfo` and add provider icons to the provider dropdown trigger and items. Small additive change.

### Step 8: Delete `PromptModelPicker`

Remove `apps/app/src/components/promptbox/PromptModelPicker.tsx` once all consumers are migrated.

## Critical Files

| File | Action |
|------|--------|
| `apps/app/src/components/icons/OpenAiIcon.tsx` | Create |
| `apps/app/src/components/icons/AnthropicIcon.tsx` | Create |
| `apps/app/src/components/icons/PiIcon.tsx` | Create |
| `apps/app/src/components/icons/index.ts` | Create |
| `apps/app/src/lib/provider-icon.ts` | Create |
| `apps/app/src/components/promptbox/PromptProviderModelPicker.tsx` | Create |
| `apps/app/src/components/promptbox/PromptOptionPicker.tsx` | Modify (export style constants) |
| `apps/app/src/components/promptbox/PromptExecutionControls.tsx` | Modify (use unified picker) |
| `apps/app/src/hooks/usePromptModelReasoning.ts` | Modify (add icons to providerOptions) |
| `apps/app/src/views/ThreadFollowUpComposer.tsx` | Modify (pass provider data through) |
| `apps/app/src/components/HireManagerModal.tsx` | Modify (add provider icons) |
| `apps/app/src/components/promptbox/PromptModelPicker.tsx` | Delete |

## Validation

1. **Typecheck**: `pnpm exec turbo run typecheck --filter=@beanbag/app`
2. **Visual QA**:
   - ProjectMainView: trigger shows `[ProviderIcon] ModelName`, dropdown shows grouped models, switching provider works
   - ThreadFollowUpComposer: read-only provider icon, model switching works
   - HireManagerModal: provider icons in dropdown
   - Single-provider scenario: no group headers, flat list
   - Fast mode toggle still works, Zap icon in trigger

## Open Questions/Risks

1. **Dropdown staying open on provider switch** — Radix DropdownMenu closes on item select by default. `event.preventDefault()` in `onSelect` should prevent this. If flaky, fallback to Popover with custom list.
2. **Loading state during provider switch** — brief empty state while models refetch. Show "Loading models..." text.
3. **Style constant sharing** — export from PromptOptionPicker vs extract to shared file. Prefer export to minimize churn.
