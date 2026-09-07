# Persist appearance choices

Status: **2026-09-05: 1 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## User goal and source

Change the app's appearance and keep it after reload.

- `apps/app/src/views/SettingsView.tsx`: Appearance controls and mutations.
- `apps/app/src/hooks/useTheme.ts`: browser-local `bb.theme` storage and the
  document root's `dark` class.
- `apps/app/src/hooks/mutations/settings-mutations.ts`: server-backed palette.
- `packages/server-contract/src/public-api.ts`: `/system/config` contract.

## Prerequisites and reach

Use the isolated server and named browser from the main skill. At desktop
1280 × 720, click **Settings**, then **Appearance** (`/settings/appearance`).
Capture the starting Theme and Palette labels so they can be restored.

## Drive

1. Click `[aria-label="Theme"]`. Snapshot the menu and select **Dark**.
2. Require `document.documentElement.classList.contains('dark')` and
   `localStorage.getItem('bb.theme') === 'dark'`. Read these values; do not
   set storage or classes from automation.
3. Reload. Wait for `[aria-label="Theme"]`, then require **Dark** and the
   same class/storage observations.
4. Click `[aria-label="Palette"]` and choose **Nord**. Wait for the Palette
   label to change, then reload and check **Nord** still appears.
5. Read `GET /api/v1/system/config` and record only `appearance.themeId`;
   require `nord`. The complete response includes more configuration than
   this proof needs. `node apps/cli/dist/index.js settings show --json` exposes the
   same server-backed setting to agents.
6. Capture the resulting appearance. Restore both initial selections through
   their menus and verify the restoration through storage and the config API.

## Observable success and gotchas

Theme and palette survive reload through their respective storage owners.
Theme preference is browser-local; do not expect it in the server config.
Palette is server-backed; a changed button label alone does not prove it was
saved. **System** follows the browser's preferred color scheme, so do not
assert that it must render light. This is a persistence check, not a complete
visual audit of every token, code theme, or palette.
