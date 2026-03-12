# Goal

Replace the thread timeline's layered auto-scroll fixes with one clearly owned scroll controller so initial load, follow-up submit, streaming updates, composer resizing, and panel/layout changes all resolve through a single scroll model.

The target is the simpler ownership pattern used in Terragon's chat UI:
- one bottom sentinel
- one hook/controller that decides whether the view is pinned to bottom
- one code path that writes scroll position

# Scope

In scope:

- `apps/app/src/hooks/useAutoScroll.ts`
- `apps/app/src/views/useThreadTimelineController.ts`
- `apps/app/src/views/ThreadTimelinePane.tsx`
- `apps/app/src/views/ThreadDetailView.tsx`
- any thread-detail subcomponents or helpers that currently write timeline scroll state indirectly
- timeline tests, plus new browser-level regression coverage for scroll behavior

This refactor includes:

- replacing the current mixed ownership model with a single timeline scroll controller
- introducing a permanent bottom sentinel inside the timeline scroll area
- moving composer resize, panel resize, and DOM-change reactions behind controller events instead of direct `scrollTop` writes
- removing bottom-path reliance on approximate row heights while pinned to bottom
- preserving non-bottom reading behavior through explicit anchor restoration owned by the controller

Out of scope:

- unrelated thread-detail visual redesign
- secondary panel feature changes beyond the scroll contract required for this refactor
- partial stopgap fixes that keep the current ownership split in place

# Implementation Steps

1. Define the new ownership boundary and controller API.
   - Create a dedicated timeline scroll controller hook, likely replacing `useAutoScroll` rather than layering on top of it.
   - The controller should be the only code allowed to call `scrollTo`, mutate `scrollTop`, or decide bottom-pinning behavior.
   - Expose explicit controller state and events instead of imperative scroll writes scattered across effects.
   - Recommended state shape:
     - `mode: "pinned_bottom" | "reading_history"`
     - `showScrollToBottom`
     - `bottomSentinelRef`
     - `scrollContainerRef`
     - `handleUserScroll`
     - `requestJumpToBottom(reason)`
     - `notifyContentChanged(reason)`
     - `notifyComposerHeightChanged(previousHeight, nextHeight)`
     - `notifyContainerWidthChanged(previousWidth, nextWidth)`

2. Introduce a real bottom sentinel and make it the canonical bottom target.
   - Render a permanent sentinel element after the final timeline content and after the ongoing `"Working..."` indicator in `ThreadTimelinePane.tsx`.
   - Stop treating `scrollHeight` as the canonical bottom target for the primary pinned-bottom path.
   - Prefer `bottomSentinel.scrollIntoView({ block: "end" | "start" })` or direct viewport scroll writes only inside the controller when browser quirks require it.
   - Keep the sentinel stable regardless of whether the thread is idle, active, empty, loading, or showing an error row.

3. Collapse all scroll writes into one frame-batched reconciliation loop.
   - Replace independent `MutationObserver`, `ResizeObserver`, layout-effect, and composer-resize scroll writes with controller event signals.
   - The controller should collect dirty reasons and reconcile once per animation frame:
     - read current layout and sticky state
     - choose one action
     - perform one scroll write if needed
   - This removes races where one effect scrolls to bottom and another effect immediately preserves an older offset.
   - Keep a small finite set of reconciliation reasons, for example:
     - `thread_changed`
     - `follow_up_submitted`
     - `rows_changed`
     - `working_indicator_changed`
     - `composer_height_changed`
     - `container_width_changed`

4. Make bottom-pinned and history-reading behavior explicit.
   - When the user is at or near the bottom, the controller should enter `pinned_bottom`.
   - When the user scrolls away from the bottom threshold, the controller should enter `reading_history`.
   - `follow_up_submitted` and thread switches should force `pinned_bottom`.
   - While in `pinned_bottom`, content growth should always reconcile to the real bottom sentinel after layout settles.
   - While in `reading_history`, new content should not jump the user to bottom.

5. Move anchor preservation into the controller as a history-only policy.
   - Keep anchor capture/restore for panel width changes and other reflows, but only when the controller is in `reading_history`.
   - Capture one explicit anchor:
     - row id
     - offset from top of viewport
   - Restore it only from the controller reconciliation path.
   - Delete any separate effect that mutates scroll position for width preservation outside the controller.

6. Move composer resize handling behind the same controller contract.
   - Stop having the composer `ResizeObserver` compute and assign `scrollTop` directly.
   - The observer should only report height changes to the controller.
   - Controller behavior:
     - in `pinned_bottom`, re-pin to the bottom sentinel
     - in `reading_history`, preserve viewport/anchor position
   - This should delete the current stale-state race between a submit-time bottom jump and prompt collapse preservation.

7. Remove deferred-height tricks from the pinned-bottom path.
   - The current thread rows use `content-visibility: auto` and `containIntrinsicSize`, which can make initial scroll height approximate rather than real.
   - The controller should disable deferred row measurement whenever it is in `pinned_bottom`.
   - Decide whether to:
     - keep deferred rendering only in `reading_history`, or
     - remove it entirely from the timeline if stability wins clearly over any measured performance benefit.
   - The important contract is that bottom-pinned reconciliation must operate on real measured content, not estimated heights.

8. Simplify `ThreadDetailView` so it does not own scroll policy.
   - `ThreadDetailView.tsx` should wire controller outputs into the view, not coordinate scroll behavior itself.
   - Remove direct scroll-policy branching from the route where possible.
   - Keep `ThreadDetailView` responsible for thread data, composer actions, and panel state, while the scroll controller owns scroll semantics.

9. Add regression coverage at the right level.
   - Keep unit tests for pure helper logic where useful, but do not rely on helper-only tests for confidence.
   - Add browser-level or DOM-level integration tests that exercise the real scroll container and sentinel.
   - Required scenarios:
     - initial thread load with tall rows and expanded entries
     - submit follow-up while pinned to bottom
     - active-thread streaming growth while pinned
     - composer grows and shrinks while pinned
     - composer grows and shrinks while reading history
     - user scrolls up, then new rows arrive
     - thread switch resets to bottom
     - secondary panel width toggles while reading history
     - `"Working..."` indicator appears and disappears without clipping
   - Include at least one scenario that reproduces the current failure class: bottom landing short because later layout growth changes the real final height.

10. Remove the old split model once the controller is proven.
   - Delete obsolete helpers/effects instead of leaving compatibility layers in place.
   - Remove any now-redundant:
     - direct `scrollToBottom()` calls outside the controller
     - duplicate sticky refs/state that exist only to bridge old logic
     - ad hoc composer/panel scroll preservation code paths
     - scroll indicator logic that is not derived from controller state
   - The final architecture should make it obvious where to look for future scroll bugs.

# Validation

- Static validation:
  - `pnpm exec turbo run typecheck --filter=@beanbag/app`
- Targeted app tests:
  - `pnpm --filter @beanbag/app test`
- Add and run focused tests for the new scroll controller and thread timeline integration.
- Run the canonical daemon/thread QA flows that exercise active thread timelines and follow-up submission if the refactor touches thread-detail behavior beyond pure rendering.
- Perform manual QA against at least:
  - a short thread
  - a long thread with tall tool/file rows
  - an active thread that streams updates
  - an idle thread that receives a follow-up
  - a thread where the composer height changes significantly before and after submit

# Open Questions/Risks

- We need to decide whether timeline row deferred rendering is worth keeping at all. If it remains, it must be cleanly gated by controller mode and never affect pinned-bottom correctness.
- Browser behavior around `scrollIntoView` can differ, especially on Safari/iOS. The controller should isolate browser-specific fallback behavior in one place instead of scattering it across effects.
- The current route and timeline code already contain several overlapping scroll assumptions. This refactor should delete old paths aggressively; partial coexistence will keep the race surface alive.
- DOM-level test reliability matters. If the existing Node-only app tests are insufficient for real scroll behavior, add browser-environment tests rather than pretending helper tests are enough.
- If performance regresses on extremely long histories after removing bottom-path virtualization, measure first and then optimize from the controller boundary, not by reintroducing hidden scroll writers.
