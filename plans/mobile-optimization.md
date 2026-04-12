# Mobile Optimization Plan

## Context

The web frontend (`apps/app`) is desktop-first and uncomfortable on phones (~375–414px viewports). Four parallel audits — typography, layout/touch-targets, navigation, inputs/interactions — surfaced a consistent picture:

- No responsive typography scale. All `ui-text-*` tokens are fixed at desktop sizes (9–12px).
- Touch targets are 28–32px across the app; iOS/WCAG minimum is 44×44.
- The thread view is locked to a horizontal split-pane that doesn't reflow on narrow screens.
- Text inputs trigger iOS autofocus zoom and lack mobile keyboard hints.
- Row actions are hover-only and unreachable on touch.
- `Dialog` does not switch to a mobile sheet the way `Dropdown`/`Popover` do.
- Composer doesn't handle the iOS virtual keyboard; no `visualViewport` handling.

Goal: make the app genuinely usable on a phone without a ground-up rewrite. Plan is sequenced so the cheap, high-leverage CSS wins ship first, structural changes last.

---

## Phase 1 — Typography, touch targets, input floors (≈1 hour)

Pure CSS/class-swap wins. Ship these first.

### 1.1 Responsive typography scale

`apps/app/src/app.css:255-273` defines a custom utility scale:

| Token | Current |
| --- | --- |
| `ui-text-3xs` | 9px / 12px lh |
| `ui-text-2xs` | 10px / 14px lh |
| `ui-text-xs` | 11px / 14px lh |
| `ui-text-sm` | 12px / 16px lh |

Add `@media (max-width: 640px)` overrides that bump each token +1–2px. On desktop everything stays identical.

Also audit the worst individual offenders and retire `ui-text-3xs` from non-decorative usage:

- `packages/ui-core/src/thread-timeline/rows/DebugEventRow.tsx:53` — `ui-text-3xs` → `ui-text-2xs`
- `packages/ui-core/src/localhost-badge.tsx:3` — `ui-text-2xs` → `ui-text-xs`
- `packages/ui-core/src/pill.tsx:29` — `ui-text-xs` → `ui-text-sm`
- `packages/ui-core/src/thread-timeline/rows/UserMessageRow.tsx:128` — attachment tags
- `packages/ui-core/src/event-content.tsx:20` — code blocks (consider `ui-text-sm` with line-height 1.6)

### 1.2 Global touch hardening in `app.css`

Add once, affects every interactive element:

- `touch-action: manipulation` on buttons, links, and inputs — removes 300ms double-tap delay.
- `-webkit-text-size-adjust: 100%` on `html`/`body` — prevents Safari auto-zoom on rotate/focus.

### 1.3 Icon button sizing

Bump every icon-only button to ≥40px on mobile. Prefer a responsive variant on the `Button` primitive rather than touching every call site.

- `apps/app/src/components/ui/button.tsx:27` — icon variant `h-9 w-9` → `h-10 w-10` (or responsive `h-10 w-10 md:h-9 md:w-9`)
- `apps/app/src/components/ui/sidebar.tsx:286` — `SidebarTrigger` `h-7 w-7` → `h-10 w-10`
- `apps/app/src/components/layout/AppLayout.tsx:162-184` — header icon buttons `h-8 w-8` → `h-10 w-10`
- `apps/app/src/components/layout/project-list/ProjectRow.tsx:159,198` — collapse chevron and kebab trigger
- `apps/app/src/components/layout/project-list/ThreadRow.tsx:71,217` — manager chevron (currently 16×16, critical) and thread kebab
- `apps/app/src/components/promptbox/PromptBox.tsx:709,729,741` — composer action buttons `h-8` → `h-11`

### 1.4 Input font-size floor + keyboard hints

iOS zooms on focus for any input under 16px.

- `apps/app/src/components/ui/input.tsx:11` — remove `text-sm`, use `text-base` (or `text-base md:text-sm` if desktop density matters).
- `apps/app/src/components/ui/textarea.tsx:12` — currently `text-base md:text-sm`; verify the composer reaches 16px on mobile (`PromptBox.tsx:652` inherits the `Textarea` styling).
- `PromptBox.tsx` — add `enterKeyHint="send"` to the composer textarea for the native send affordance on mobile keyboards.
- Rename / name inputs — add `autocapitalize="words"` where appropriate, `autocorrect="off"` on technical fields (project slugs, branch names).

### Exit criteria (Phase 1)

- On an iPhone-sized viewport (DevTools, 390×844), all utility text is ≥10px; body text is ≥12px.
- All icon buttons measure ≥40×40 in DevTools.
- Focusing any text input does not trigger a zoom in iOS Simulator Safari.
- Composer keyboard shows a "send" return-key on iOS.

---

## Phase 2 — Touch correctness for menus and dialogs (≈2 hours)

Fixes cases where features exist but are unreachable on touch.

### 2.1 Always-visible row actions on touch devices

Thread and project row kebab menus are hidden behind `group-hover:opacity-100` and become undiscoverable without a pointer.

- `apps/app/src/components/layout/project-list/ThreadRow.tsx:207-211`
- `apps/app/src/components/layout/project-list/ProjectRow.tsx` (folder action buttons)
- `packages/ui-core/src/thread-timeline/rows/UserMessageRow.tsx` (copy/action buttons)

Approach: wrap the hover-only opacity classes with a CSS `@media (hover: hover)` guard so touch devices get the always-visible state. No JS detection needed — the media query is the right primitive here.

### 2.2 Mobile `Dialog` variant

`apps/app/src/components/ui/dialog.tsx:38-42` renders a centered popup at all sizes. The `DropdownMenu` and `Popover` primitives already switch to a Drawer below `md` — mirror that pattern.

Approach:
- Factor the `useIsMobile()` check already used in `dropdown-menu.tsx` / `popover.tsx`.
- Below the breakpoint, render `DialogContent` through the `Drawer` primitive (bottom sheet) with the same children.
- Keep the desktop path byte-identical.

All existing `Dialog` callers benefit without changes.

### 2.3 Sidebar density on mobile

`sidebar.tsx` menu items are `h-8` (32px) with `p-2`. Tight for thumbs.

- Menu item height: `h-8` → `h-10` under `md`.
- Group label height: `h-8` → `h-10`.
- Keep desktop behaviour untouched.

### Exit criteria (Phase 2)

- Kebab menus on thread/project rows visible without hover in DevTools touch-emulation mode.
- Opening any `Dialog` on a 390×844 viewport renders as a bottom sheet with safe-area padding.
- Sidebar rows are comfortable thumb targets (≥40px).

---

## Phase 3 — Thread view and iOS keyboard (≈4 hours)

Structural work. Saved for last because it touches the main reading surface.

### 3.1 Vertical split on mobile

`apps/app/src/views/ThreadDetailSecondaryContent.tsx:462` hard-codes `PanelGroup direction="horizontal"`. On phones this creates two unreadable columns plus a draggable resize handle.

Approach:
- Thread the `useIsMobile()` result into the panel group: `direction={isMobile ? "vertical" : "horizontal"}`.
- Hide `PanelResizeHandle` when mobile (`apps/app/src/views/ThreadSecondaryPanel.tsx:397-405`).
- Consider collapsing the secondary panel to a bottom sheet by default on mobile, with an expand affordance — but a plain vertical stack is an acceptable v1.
- Verify diff/code blocks in the secondary panel don't trigger horizontal scroll after stacking. Add `max-w-full` / `overflow-x-auto` on code surfaces where needed.

### 3.2 Composer + iOS keyboard

`apps/app/src/components/layout/PageShell.tsx:52-63` hosts the composer. `.chat-prompt-box` (`app.css:237-241`) applies `env(safe-area-inset-bottom)` only in standalone/PWA mode.

Approach:
- Apply safe-area-inset bottom padding unconditionally on the composer container, not only standalone.
- Listen to `window.visualViewport` `resize`/`scroll` events and set a CSS custom property (e.g. `--kb-offset`) equal to `innerHeight - visualViewport.height`. Apply `transform: translateY(calc(-1 * var(--kb-offset)))` or `padding-bottom` on the composer container so the keyboard does not cover the input.
- Test on real iOS Safari — visualViewport behaviour differs from DevTools.

### 3.3 Breadcrumb overflow

`apps/app/src/components/layout/AppLayout.tsx:119-149` — breadcrumb row has no wrapping or narrow-viewport strategy.

Approach:
- Hide intermediate breadcrumb segments below `sm` (show only root + current).
- Or collapse to a single "‹ Back" affordance on phones when there's a parent route.

### Exit criteria (Phase 3)

- Thread view on a 390×844 viewport stacks timeline above secondary content with no horizontal scroll.
- Focusing the composer on a real iOS device keeps the input visible above the keyboard.
- Breadcrumbs never wrap onto two lines or push the header taller than 48px on mobile.

---

## Validation

After each phase, validate against the exit criteria above. For the full plan:

1. DevTools device emulation: iPhone 13 (390×844), iPhone SE (375×667), Pixel 7 (412×915). Check thread list, thread detail, settings, new-project flow, and every `Dialog` the app exposes.
2. Real-device smoke test on iOS Safari (keyboard behaviour, safe area, auto-zoom) and Android Chrome (touch targets, `enterKeyHint`).
3. Lighthouse mobile accessibility audit — score should not regress, and tap-target warnings should drop substantially.
4. No regressions on desktop: all changes gated by `@media (max-width: …)` or `useIsMobile()`, so desktop rendering should be byte-identical except where we've deliberately unified sizing.

## Out of scope

- Bottom tab bar / native-feel nav restructure. The current sidebar drawer is adequate.
- Rewriting `react-resizable-panels` usage — we reuse it in mobile mode, just change direction.
- Offline / PWA improvements.
- Rethinking information density on desktop.

## Rollout

Phases are independent and each ships behind its own PR. Phase 1 is safe to ship immediately; Phase 2 and 3 want manual QA on a real phone before merge.
