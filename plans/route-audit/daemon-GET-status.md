# `GET /status` — Return Connection Status (Host-Daemon Local API)

**Route:** `apps/host-daemon/src/local-api.ts:42`
**Contract:** `EmptyInput -> StatusResponse` (200)
**Complexity:** Simple

## Request Body (or Params)

| Field    | Required | Notes     |
| -------- | -------- | --------- |
| _(none)_ | --       | No input. |

## Implementation Trace

1. `typedRoutes` registers `GET /status` with a no-body handler.
2. Handler calls `options.getConnected()` to obtain a `boolean` indicating WebSocket/server connection state.
3. Returns `c.json({ connected, serverUrl: options.serverUrl })`.
4. Both values are derived from construction-time options; `getConnected` is a live callback, `serverUrl` is static.

> **-> HTTP 200 returns here.**

## Code Reuse

- Uses `typedRoutes` helper for contract enforcement.

## Flags

> **Updated 2026-03-29:** `GET /host-id` merged into this route. Now returns `{ hostId, connected, serverUrl }`.

None. Clean.

## Usages

| Caller                        | Location                                        | Purpose                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createHostDaemonLocalClient` | `packages/host-daemon-contract/src/local.ts:64` | Typed Hono client factory; defines the `/status` route type                                                                                                        |
| local-api test                | `apps/host-daemon/src/local-api.test.ts:37`     | Integration test that verifies `GET /status` returns `connected` and `serverUrl`                                                                                   |
| _(no app callers)_            | --                                              | The frontend app (`apps/app`) does not call this route; it discovers daemon reachability via `GET /host-id` and server connectivity via the server's own WebSocket |
| _(no CLI callers)_            | --                                              | The CLI (`apps/cli`) does not call this route; it only uses `GET /host-id`                                                                                         |

---

## Review Comments

I wonder if we can merge host-id into /status

> Done — `GET /host-id` merged into `GET /status`. The response now includes `hostId` alongside `connected` and `serverUrl`. `GET /host-id` has been deleted. All callers (app, CLI) updated to use `/status`.
