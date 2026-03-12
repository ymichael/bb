# Goal

Extract the duplicated delayed hover-popover behavior used by frontend status affordances into a shared primitive so the interaction is consistent, easier to maintain, and simpler to extend without behavior drift.

# Scope

- Replace the duplicated hover-open / delayed-close popover state machine in:
  - `apps/app/src/components/shared/WorkspaceStatusIndicator.tsx`
  - `apps/app/src/components/thread/ThreadContextWindowIndicator.tsx`
- Introduce one shared hook or primitive in `apps/app/src/hooks` or a similarly appropriate shared location.
- Preserve existing pointer, focus, and Radix `Popover` behavior unless a targeted accessibility improvement is explicitly included.
- Keep the change limited to shared behavior extraction; do not broaden into unrelated popover redesign or visual restyling in this pass.

# Implementation Steps

1. Inspect both current implementations and identify the exact shared behavior:
   - open state ownership
   - pointer enter / leave handling for trigger and content
   - delayed close timeout cleanup
   - `onOpenChange` bridging with Radix `Popover`
2. Introduce a shared hook, likely `useHoverPopover`, that returns:
   - `open`
   - trigger hover props
   - content hover props
   - a stable `handleOpenChange`
3. Refactor `WorkspaceStatusIndicator` to consume the shared hook and remove duplicated local hover state, timeout refs, and effects.
4. Refactor `ThreadContextWindowIndicator` to consume the same shared hook and remove the parallel implementation.
5. Check whether any light abstraction cleanup is needed:
   - shared close-delay constant
   - event handler naming
   - minimizing prop spreading if readability suffers
6. Run frontend linting and, if useful, targeted tests covering the affected components or nearby rendering paths.

# Validation

- Run `pnpm --filter @beanbag/app lint`.
- If component tests exist or are cheap to run, run targeted tests for the affected area.
- Manually verify in the app that both indicators:
  - open on hover
  - stay open while moving from trigger to popover content
  - close after the delay when pointer leaves both regions
  - still respond correctly to direct open/close events from Radix

# Open Questions/Risks

- If either component relies on subtly different timing or alignment assumptions, extracting too aggressively could create a small behavior regression.
- Radix `Popover` interaction semantics can differ between pointer and keyboard usage; the shared hook should avoid accidentally degrading non-pointer behavior.
- If more hover-driven popovers exist later, this may want to become a shared UI primitive rather than just a hook.
