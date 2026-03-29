# `GET /host-id` — Return Host Identity (Host-Daemon Local API)

**Route:** `apps/host-daemon/src/local-api.ts:38`
**Contract:** `EmptyInput -> HostIdResponse` (200)
**Complexity:** Simple

## Request Body (or Params)

| Field    | Required | Notes     |
| -------- | -------- | --------- |
| _(none)_ | --       | No input. |

## Implementation Trace

1. `typedRoutes` registers `GET /host-id` with a no-body handler (no Zod schema passed).
2. Handler calls `c.json({ hostId: options.hostId })`.
3. `options.hostId` is a `string` passed in at server construction time; it is not fetched or derived per-request.

> **-> HTTP 200 returns here.**

## Code Reuse

- Uses `typedRoutes` helper from `@bb/hono-typed-routes` for compile-time contract enforcement.
- No other shared functions involved.

## Flags

> **Updated 2026-03-29:** Route deleted — merged into `GET /status`.

~~None. Clean.~~

**This route has been deleted.** See `daemon-GET-status.md`.

## Usages

| Caller                        | Location                                        | Purpose                                                                                                                                 |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchHostId`                 | `apps/app/src/lib/api-host-daemon.ts:22`        | Fetches local host ID from daemon; called by `localHostIdAtom` on app startup and on host-connected WS events                           |
| `localHostIdAtom`             | `apps/app/src/lib/atoms.ts:35`                  | Jotai atom that calls `fetchHostId(port)` to resolve the local host ID for the app                                                      |
| `useHostDaemon` hook          | `apps/app/src/hooks/useHostDaemon.ts:20`        | Reads `localHostIdAtom`; exposes `localHostId` to views (`ProjectMainView`, `ThreadDetailView`, `ProjectList`, `useQuickCreateProject`) |
| `fetchLocalHostId`            | `apps/cli/src/daemon.ts:11`                     | CLI daemon client; calls `client["host-id"].$get()` with caching; used by CLI commands                                                  |
| `project` commands            | `apps/cli/src/commands/project.ts`              | Calls `fetchLocalHostId()` for `project add-source`, `project show`, `project list`, `project remove-source`, `project set-main-source` |
| `status` command              | `apps/cli/src/commands/status.ts:92`            | Calls `fetchLocalHostId()` to identify which environment is local                                                                       |
| `spawn` command               | `apps/cli/src/commands/thread/spawn.ts:147`     | Calls `fetchLocalHostId()` to tag new threads with the local host                                                                       |
| `createHostDaemonLocalClient` | `packages/host-daemon-contract/src/local.ts:64` | Typed Hono client factory; defines the `/host-id` route type used by all callers                                                        |
| local-api test                | `apps/host-daemon/src/local-api.test.ts:36`     | Integration test that verifies `GET /host-id` returns the expected host ID                                                              |

---

## Review Comments

see comment in /status

> Done — `GET /host-id` has been merged into `GET /status`. The `/status` endpoint now returns `hostId` alongside `connected` and `serverUrl`. All callers updated to use `/status` instead.
