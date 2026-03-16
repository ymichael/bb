# Frontend React Review Checklist

Use this checklist for larger React and frontend changes in `apps/app/src/**`.

## State Ownership

- Is any local state copied from props, query data, or fetched server state?
- If yes, can it be derived during render instead?
- If local draft state is intentional, is there an explicit reset key or dirty/touched model so refetches do not clobber user edits?

## Effects

- Does every `useEffect` or `useLayoutEffect` synchronize with something external?
- Is any effect doing event-specific work that should live in a click, submit, expand, or change handler instead?
- Can any effect be replaced by render-time derivation, keyed remounting, or reducer state transitions?

## Hooks Safety

- Are all hooks called unconditionally before any early return?
- Is `eslint-plugin-react-hooks` clean without local disables?
- Are effect dependencies primitive and explicit where possible?

## Shared UI

- Does this change duplicate interaction behavior that already exists elsewhere?
- Can shared prompt controls, popover behavior, status displays, or detail primitives be reused instead of introducing view-local variants?
- If a new shared pattern is needed, should it become a hook or shared component now rather than after a second copy appears?

## Scroll And Layout

- If the change resizes or reflows content, does it preserve viewport position when the user is scrolled away from the bottom?
- If the user is intentionally pinned to bottom, does it keep them pinned?
- For timeline and diff changes, has composer growth, panel resize, tool-group expansion, and diff navigation been considered?

## Validation

- Run `pnpm --filter @bb/app lint`.
- Run `pnpm --filter @bb/app build`.
- Run targeted tests for any extracted pure helpers or hooks.
- For scroll-sensitive changes, manually verify pinned-bottom and scrolled-up cases.
