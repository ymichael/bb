# Use a compact persistent menu

Status: **2026-09-05: 1 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## User goal and source

Choose an appearance option in a narrow viewport and reopen the menu without
losing its content or disabling the app root.

- `apps/app/src/views/SettingsView.tsx`: Theme menu entry.
- `packages/shared-ui/src/components/ui/responsive-overlay.tsx`:
  `PersistentResponsiveDrawerShell` and deferred content realization.
- `apps/app/src/components/ui/responsive-overlay.test.tsx`: existing
  regression coverage for overlay ownership and deferred content.

## Prerequisites and reach

Open Appearance through the app navigation, then set the named page viewport:

```javascript
const p = await browser.getPage("bb");
await p.setViewport({
  width: 390,
  height: 844,
  isMobile: true,
  hasTouch: true,
});
await p.waitForSelector('[aria-label="Theme"]');
console.log(await p.snapshot({ interactive: true }));
```

Viewport changes may reload the page. Wait for its content and snapshot again.
Record the initial Theme value for restoration.

## Drive

1. Click `[aria-label="Theme"]` and wait for
   `[data-persistent-drawer-content][data-state="open"]`.
2. Wait separately for that drawer's `[role="menuitem"]`. An open shell can
   precede realized content; its presence alone is not a usable menu.
3. Check `#root` is present, its `inert` property is false, and its
   `aria-hidden` attribute is not `true`. Capture the open drawer and read
   the screenshot at 390 × 844.
4. Select **Light** by its fresh snapshot reference. Wait for
   `[data-persistent-drawer-content][data-state="closed"]` and require the
   Theme value and `bb.theme` storage to become `light`.
5. Require the closed drawer to retain its menuitem elements. Its own hidden
   and inert state is expected; the app root must remain usable.
6. Click Theme again, require its realized menuitems, press Escape, and
   require the drawer to close. Reopen and restore the initial Theme value.
7. Restore the desktop viewport and confirm the surrounding settings remain
   usable. Capture observations of open, closed, retained, and reopened states.

## Observable success and limits

The option changes through input, the drawer closes and reopens, its realized
content remains mounted, and the app root is non-inert and exposed in the
observed open, closed, and reopened states.
The initial run used Chromium mobile emulation. This does not establish the
two-animation-frame timing, transient attribute behavior, animation speed, or
Safari correctness. Changes to the drawer implementation still need the
existing focused tests and iOS Simulator Safari verification required by
AGENTS.md. Record that prerequisite as unavailable on Linux rather than
claiming this smoke check substitutes for it.
