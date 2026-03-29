# `POST /pick-folder` — Show Native Folder Picker (Host-Daemon Local API)

**Route:** `apps/host-daemon/src/local-api.ts:54`
**Contract:** `EmptyInput -> PickFolderResponse` (200)
**Complexity:** Medium

## Request Body (or Params)

| Field | Required | Notes |
|---|---|---|
| _(none)_ | -- | No input. |

## Implementation Trace

1. `typedRoutes` registers `POST /pick-folder` with a no-body handler.
2. Handler calls `options.pickFolder ?? pickLocalFolder`.
3. **Default `pickLocalFolder` (line 112):**
   - If `process.platform !== "darwin"`, returns `null` immediately (non-macOS platforms unsupported).
   - On macOS, calls `execFileAsync("osascript", [...])` with an AppleScript that runs `choose folder`.
   - The AppleScript catches user-cancel (error -128) and returns empty string.
   - If `stdout.trim()` is empty, returns `null`.
   - Otherwise returns the selected path with trailing slash stripped via `.replace(/\/$/, "")`.
4. Handler returns `c.json({ path })` where `path` is `string | null`.

> **-> HTTP 200 returns here.**

## Code Reuse

- `pickLocalFolder` is module-private; callers can inject `options.pickFolder`.
- Uses `execFileAsync` (promisified `execFile`) for the subprocess call.

## Flags

1. **Non-macOS silently returns null.** On Linux/Windows the default implementation returns `null` with no indication that the feature is unsupported. A 501 or a distinct response field would be more informative.
2. **osascript failure is unhandled.** If `osascript` is missing or the AppleScript errors for a reason other than -128, `execFileAsync` throws and the error propagates as an unstructured 500 (no `onError` handler).
3. **CORS `*` exposure.** Same as `POST /open` -- any webpage the user visits can trigger this route. While the folder picker requires user interaction (they must click in the dialog), it is still surprising that a random webpage can pop an OS dialog.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `pickFolder` | `apps/app/src/lib/api-host-daemon.ts:46` | Calls `daemon["pick-folder"].$post({})` and returns the selected path or `null` |
| `useHostDaemon` hook | `apps/app/src/hooks/useHostDaemon.ts:47` | Wraps `daemonPickFolder(port)` into a stable callback; returns `null` if no daemon |
| `ProjectList` | `apps/app/src/components/layout/ProjectList.tsx:127,222` | Destructures `pickFolder` from `useHostDaemon()`; calls it to let the user pick a source folder when adding a project source |
| `useQuickCreateProject` | `apps/app/src/hooks/useQuickCreateProject.ts:8,13` | Calls `pickFolder()` to select a folder, then creates a project with the selected path |
| `createHostDaemonLocalClient` | `packages/host-daemon-contract/src/local.ts:64` | Typed Hono client factory; defines the `/pick-folder` route type |
| local-api test | `apps/host-daemon/src/local-api.test.ts:61` | Integration test that verifies `POST /pick-folder` delegates to the `pickFolder` callback |
| _(no CLI callers)_ | -- | The CLI does not call this route |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->