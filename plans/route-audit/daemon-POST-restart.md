# `POST /restart` — Restart the Daemon (Host-Daemon Local API)

**Route:** `apps/host-daemon/src/local-api.ts:59`
**Contract:** `EmptyInput -> Record<string, never>` (200)
**Complexity:** Simple

## Request Body (or Params)

| Field | Required | Notes |
|---|---|---|
| _(none)_ | -- | No input. |

## Implementation Trace

1. `typedRoutes` registers `POST /restart` with a no-body handler.
2. Handler calls `options.scheduleRestart ?? defaultScheduleRestart`, passing a callback that invokes `void options.restart()`.
3. **Default `defaultScheduleRestart` (line 93):** calls `setTimeout(restart, 0)` -- defers the restart to the next event-loop tick so the HTTP response can flush first.
4. The restart callback calls `options.restart()` (which returns `Promise<void> | void`); the result is `void`-cast (fire-and-forget).
5. Handler returns `c.json({})` synchronously, before the restart executes.

> **-> HTTP 200 returns here.** Restart happens asynchronously after the response.

## Code Reuse

- `defaultScheduleRestart` is a 1-line module-private helper.
- Callers can inject `options.scheduleRestart` to control timing (used in tests).

## Flags

1. **Restart errors are silently swallowed.** The `void` cast on `options.restart()` means if the restart promise rejects, the error becomes an unhandled rejection. Consider `.catch(console.error)` or similar.
2. **CORS `*` exposure.** Any webpage the user visits can `POST /restart` and force-restart the daemon. This is the most impactful CORS concern -- it is a denial-of-service vector from any browser tab.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `createHostDaemonLocalClient` | `packages/host-daemon-contract/src/local.ts:64` | Typed Hono client factory; defines the `/restart` route type |
| local-api test | `apps/host-daemon/src/local-api.test.ts:82` | Integration test that verifies `POST /restart` responds 200 and invokes the restart callback |
| _(no app callers)_ | -- | The frontend app (`apps/app`) does not call this route; there is no restart button or trigger in the UI |
| _(no CLI callers)_ | -- | The CLI does not call this route |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->