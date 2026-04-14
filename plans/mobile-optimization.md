# Mobile Optimization Plan

## Context

The web frontend (`apps/app`) is desktop-first and uncomfortable on phones (~375–414px viewports). Four parallel audits — typography, layout/touch-targets, navigation, inputs/interactions — surfaced a consistent picture:

- No responsive typography scale. Text-xs / text-sm too small at phone viewing distance.
- Touch targets are 28–32px across the app; iOS/WCAG minimum is 44×44.
- The thread view is locked to a horizontal split-pane that doesn't reflow on narrow screens.
- Text inputs trigger iOS autofocus zoom and lack mobile keyboard hints.
- `Dialog` does not switch to a mobile sheet the way `Dropdown`/`Popover` do.
- Composer doesn't handle the iOS virtual keyboard; no `visualViewport` handling.

Goal: make the app genuinely usable on a phone without a ground-up rewrite.

## Progress

**Shipped** (commit `43fea405`): Phase 1 typography + touch hardening + most icon-button sizing + input floors; Phase 2 sidebar density; provider refactor + route-derivation hook + server archive idempotency + picker/menu icon bumps (not originally planned).

**Deferred**: Phase 2 mobile Dialog variant; Phase 3 vertical thread split, iOS keyboard, breadcrumb overflow.

**Declined**: Phase 2.1 always-visible touch row actions — the same actions are reachable from the thread detail page and project header, so hover-only sidebar kebabs are intentional.

---

## Phase 1 — Typography, touch targets, input floors · DONE

### 1.1 Responsive typography scale · DONE (with deviation)

**Deviation from plan:** instead of bumping the custom `ui-text-*` scale, we deleted it and migrated every usage to Tailwind's `text-xs` (24+ files). Five micro-badges (localhost, attachment tag, debug reason, mention dirname, host status) are pinned to `text-[10px]` to preserve their intentional tinyness. `app.css` gets a `@media (max-width: 767px)` override that bumps `.text-xs` 12→14px and `.text-sm` 14→15px. No `!important` — cascade order via `@layer utilities` wins.

The breakpoint was chosen to match `md:` (768px) so icon-size bumps and text-size bumps fire simultaneously; earlier the scale used 640px and produced a jarring intermediate state where icons had grown but text hadn't.

### 1.2 Global touch hardening · DONE

`app.css` adds `touch-action: manipulation` on buttons/links/inputs/etc. and `-webkit-text-size-adjust: 100%` on `html`.

### 1.3 Icon button sizing · DONE (smaller targets than plan called for)

**Deviation from plan:** after iterating on visual feel, most icon buttons landed at `h-9` (36px) on mobile rather than the plan's `h-10` (40px) / WCAG's `h-11` (44px). Project header / thread header / sidebar-row kebabs at `h-9` felt tighter and more balanced against their neighbors than `h-10`. A few deliberately larger:

- Composer buttons (attach, voice, send, stop, cancel): `h-10` mobile — primary action targets.
- SidebarTrigger in mobile drawer: `h-10`.
- AppSidebar footer (theme/settings): `h-9`.

If a future round of QA determines 36px is causing mis-taps, the fix is one responsive class per site.

Sidebar row slots (project collapse, thread leading glyph, trailing kebab) bumped in lockstep so rows stay aligned. Icon-inside-button sizes bumped `size-4` → `size-5` on mobile across sidebar, headers, menus, and pickers.

### 1.4 Input font-size floor + keyboard hints · DONE (one gap)

- `Input` primitive and composer textarea: `text-base md:text-sm` + `h-10 md:h-9` — eliminates iOS autofocus zoom.
- Composer gets `enterKeyHint="send"`.

**Gap:** `autocapitalize` / `autocorrect` hints not added to rename dialogs (`ProjectRenameDialog.tsx`, `ThreadRenameDialog.tsx`). Five-minute follow-up; not critical.

### Exit criteria · met

- All utility text ≥12px on mobile; body text ≥14px.
- Icon buttons measure 32–40px on mobile (below the 44px plan goal; see deviation note).
- Text inputs don't trigger iOS auto-zoom.
- Composer keyboard shows "send" return key.

---

## Phase 2 — Touch correctness for menus and dialogs

### 2.1 Always-visible row actions on touch devices · DECLINED

The same rename/archive/delete actions are reachable from:

- `ThreadActionsMenu` on the thread detail page header,
- `ProjectActionsMenu` in the project page header (now wired to the new provider — previously a stub).

Adding always-visible sidebar kebabs would duplicate chrome for no real discoverability gain on touch. Kebabs stay hover-only.

### 2.2 Mobile `Dialog` variant · DEFERRED

`dialog.tsx:38-42` still renders a centered popup at all sizes. Rename, delete confirmation, archive confirmation, project path, hire manager, git action — every `Dialog` in the app would benefit.

Approach (unchanged from original plan):
- Factor the `useIsMobile()` check already used in `dropdown-menu.tsx` / `popover.tsx`.
- Below `md`, render `DialogContent` through the `Drawer` primitive with the same children.
- Desktop path byte-identical.

Estimated ~1 hour. High leverage.

### 2.3 Sidebar density on mobile · DONE (per-row, not via primitive)

**Deviation from plan:** the plan called for bumping `SidebarMenuButton` variants in `sidebar.tsx`. We bumped the custom `ProjectRow` / `ThreadRow` row heights (`h-8`→`h-10`, `h-7`→`h-9`) directly. Same end result.

Sidebar footer (theme toggle + settings) also bumped to `h-9 w-9` mobile via `AppSidebar.tsx`.

---

## Phase 3 — Thread view and iOS keyboard · DEFERRED

Structural work. Needs real-device QA before landing.

### 3.1 Secondary panel as bottom drawer on mobile

`ThreadDetailSecondaryContent.tsx:462` still hard-codes `PanelGroup direction="horizontal"`. On phones this creates two unreadable columns plus a draggable resize handle.

**Approach:** port the pattern from terragon-labs/terragon-oss (`apps/www/src/components/chat/secondary-panel.tsx`). Branch *inside* `ThreadDetailSecondaryContent` on `useIsMobile()`:

- Mobile: render the secondary content inside our existing shadcn `Drawer` (vaul) at `h-[80vh]`. Don't render `PanelGroup` at all.
- Desktop: existing `PanelGroup` + resizable split unchanged.
- **Same inner content component in both branches** — extract the current secondary-panel body into a `SecondaryContent` component so there's no duplicated rendering tree.

**Open state:**
- Single source of truth (current open-state already lives in view-level state).
- Default closed on mobile every time, regardless of desktop persistence. Avoids the "drawer pops open on every page load" trap.
- Keep desktop's persistence (whatever we have today) gated to non-mobile.

**Toggle UX:**
- Reuse the existing header toggle button.
- Swap icon based on `useIsMobile()`: `PanelBottom` on mobile, `PanelRight` on desktop. Same handler. Both icons exist in lucide.

**Chrome:**
- Ensure the thread shell uses `h-[100dvh]` so the 80vh drawer isn't clipped by the mobile URL bar. (We may already have this; verify.)
- No explicit snap points, safe-area padding, or scroll restoration for v1 — vaul handles the grip, and the inner content already uses `overflow-auto`.

**Won't do in v1:**
- No swipe-to-open from a screen edge.
- No snap points.
- No separate mobile "tab bar"-style navigation for switching between git-diff / thread-storage / info panels inside the drawer — the existing panel picker inside the content should work as-is inside the drawer.

**Estimated scope:** ~40 lines plus content extraction. No new deps (we already have `Drawer`, `useIsMobile()`, `PanelBottom`, `PanelRight`).

**Reference:** see repo research notes in conversation on 2026-04-13.

### 3.2 Composer + iOS keyboard

`.chat-prompt-box` safe-area-inset is still gated to PWA standalone mode (`app.css`); no `visualViewport` listener.

Approach unchanged: unconditional safe-area bottom padding; listen to `window.visualViewport` and set a `--kb-offset` custom property; translate the composer container so the keyboard never covers it.

### 3.3 Breadcrumb overflow

`AppLayout.tsx` breadcrumb block has no narrow-viewport strategy. Approach unchanged: hide intermediate segments below `sm`, or collapse to a "‹ Back" affordance.

---

## Out-of-plan work shipped in `43fea405`

Surfaced during the session and included:

- Mobile sidebar width → `min(90vw, 320px)` (previously fixed `18rem`).
- `POST /threads/:id/archive` made idempotent on already-archived — matching `unarchive` and eliminating the race where a "force archive" confirmation could land after the thread was already archived from another tab.
- `ProjectActionsProvider` + `ThreadActionsProvider` extract project/thread mutations, dialogs, and callbacks from inline consumers; `ProjectActionsMenu` and the rewritten `ThreadActionsMenu` read from context. Deletes ~600 lines of duplicated mutation/dialog plumbing from `ProjectList` and `ThreadDetailView`.
- `useAppRoute` hook centralizes `useMatch`-based route derivation (single source of truth for "am I on a project/thread/settings view").
- `useHoverPopover` disables pointer tracking on mobile so tap-to-open works predictably.
- `Popover` mobile drawer now gets default `px-4 pt-2 pb-[safe-area]` padding so contents don't sit flush against the drawer edges.
- Model picker, environment picker, host picker, merge-base picker, dropdown checkmarks, and sidebar footer all bumped to mobile-friendly sizes.

---

## Remaining work (priority order)

1. **Phase 1.4 gap** — add `autocapitalize="words"` / `autocorrect="off"` on `ProjectRenameDialog` and `ThreadRenameDialog` inputs. Also consider `autocorrect="off"` on project path / branch inputs. **5 min.**
2. **Phase 2.2 Mobile Dialog → Drawer** — highest-leverage remaining item. Pattern already exists for Dropdown and Popover. Affects every `Dialog` caller automatically. **~1 hr.**
3. **Phase 3.2 iOS keyboard handling** — real-device-dependent but high impact for anyone drafting a message on their phone. **~1.5 hr.**
4. **Phase 3.3 Breadcrumb overflow** — quick once we decide the UX (hide intermediates vs. "‹ Back" affordance). **~30 min.**
5. **Phase 3.1 Vertical split** — biggest structural change. Should ship behind its own review. **~2 hr.**

---

## Validation checklist (run before each remaining merge)

1. DevTools device emulation: iPhone 13 (390×844), iPhone SE (375×667), Pixel 7 (412×915). Check thread list, thread detail, settings, new-project flow, and every `Dialog` the app exposes.
2. Real-device smoke test on iOS Safari (keyboard behaviour, safe area, auto-zoom) and Android Chrome (touch targets, `enterKeyHint`).
3. Lighthouse mobile accessibility audit — score shouldn't regress; tap-target warnings shouldn't increase (may still warn given our `h-9` / 36px decision below WCAG 44px).
4. No regressions on desktop: changes gated by `@media (max-width: …)` or `md:` / `useIsMobile()`; desktop rendering should be byte-identical except where we've deliberately unified sizing.

## Out of scope

- Bottom tab bar / native-feel nav restructure. The sidebar drawer is adequate.
- Rewriting `react-resizable-panels` — we reuse it in mobile mode, just change direction.
- Offline / PWA improvements.
- Rethinking information density on desktop.
