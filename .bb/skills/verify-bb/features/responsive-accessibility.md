# Responsive layouts, accessibility, and performance

Status: **2026-09-05: 8 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Repeat relevant core and plugin recipes at wide, split-pane, compact, and
software-keyboard-constrained sizes. Use actual iOS Simulator Safari/WebView
for WebKit claims and keyboard/screen-reader tools for accessibility. Large
fixtures belong in an isolated store; inspect `seed:perf` before running it
because it writes data. Capture OS/browser, dataset size and trace methodology;
there is no invented universal timing budget.

## Source

- `packages/shared-ui/src/components/ui/responsive-overlay.tsx`
- `apps/app/src/components/ui/theme.css`
- `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx`
- `apps/app/src/lib/app-command-metadata.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Compact overlays | Open representative provider/appearance pickers, menus and dialogs; select, close/reopen and press Escape. | Drawer transform begins before heavy content, realized content remains reusable, and the app root is never made inert or aria-hidden. |
| Deferred realization | Observe shell animation and heavy content mount across frames, including rapid reopen and timeout fallback. | Content realizes after the intended frame boundary/fallback without blank or double-mounted interactive content. |
| Keyboard and focus | Navigate sidebar, composer, question card and overlay using Tab/Shift+Tab/Enter/Escape plus advertised shortcuts. | Focus remains visible, actions affect the focused context, and closing returns usable focus. |
| Accessible names and structure | Inspect labels, roles, selected/expanded states, errors and announcements with a screen reader. | Controls and state changes are understandable without pointer input; disabled/hidden content is announced correctly. |
| Themes and contrast | Repeat custom tinted palettes, System/Light/Dark, selection, hover and layered overlays. | Colors derive from active anchors; text/focus remain readable without stranded neutral surfaces. |
| Timeline and sidebar scale | Load a large synthetic history/thread set and profile scroll, navigation and incremental updates. | Pagination/windowing preserves correct content and anchoring; report measured stalls and dataset rather than declaring an unmeasured pass. |
| WebKit style cost | Profile representative compact drawers in Safari; if slow, disable suspect stylesheets and measure recalculation on the same fixture. | Evidence separates style recalculation from mount/render work; no scoped-rule regression is hidden by Chromium-only testing. |
| Reconnect and responsive state | Change viewport and reconnect with an open drawer, split pane and pending question. | Selections, draft and pending state survive without invisible blocking overlays or inaccessible actions. |

## Evidence and cleanup

Record each row and platform separately with the actual entry point, observed
state, persisted side effect, and evidence. Missing hardware/service access is
a prerequisite gap, not a pass. Stop only owned sessions/processes, restore
preferences, and remove only synthetic resources after evidence is preserved.

## Maintenance notes

- Use desktop Safari on macOS for desktop WebKit claims; use iOS Simulator Safari/WebView separately for iOS claims. Preflight Safari WebDriver remote automation without changing owner preferences. Record each client independently and exclude iOS variants when requested. Source: `packages/shared-ui/src/components/ui/responsive-overlay.tsx:208; live safari-session.json`.
