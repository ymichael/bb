# `GET /api/v1/system/providers` — List Available Providers

**Route:** `apps/server/src/routes/system.ts:41`
**Contract:** `{ query?: SystemProvidersQuery } -> SystemProviderInfo[]` (200)
**Complexity:** Medium (resolves host, dispatches daemon command)

## Request Body (or Params)

| Field                   | Required | Notes                                                                                                       |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `environmentId` (query) | Optional | If provided, resolves to the environment's `hostId` via `requireEnvironment`. Takes priority over `hostId`. |
| `hostId` (query)        | Optional | Used directly if `environmentId` is not provided.                                                           |

If neither is provided, `requireDefaultConnectedHostId` finds the most recently updated active session.

**All 2 fields consumed. No dead params.**

## Implementation Trace

1. (sync) `resolveHostId(deps, query)`:
   - If `query.environmentId`: calls `requireEnvironment(db, environmentId)` (PK lookup), returns `environment.hostId`.
   - Else if `query.hostId`: returns it directly (no validation that the host exists).
   - Else: `requireDefaultConnectedHostId(db)` — queries `host_daemon_sessions` for the most recently updated active session. Throws 502 if none found.
2. (async) `queueCommandAndWait(deps, {...})` — queues `provider.list` command. Standard daemon proxy flow.
3. (sync) Parses result with `hostDaemonCommandResultSchemaByType["provider.list"]`, returns `.providers`.

> **-> HTTP 200 returns here.** No background work.

## DB Query Summary

| #   | Query                                                                                                                  | Table                  | Index                                  | Notes                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------- | -------------------------------------- |
| 1a  | `SELECT * FROM environments WHERE id = ?`                                                                              | `environments`         | PK                                     | Only if `environmentId` provided       |
| 1b  | `SELECT hostId FROM host_daemon_sessions WHERE status='active' AND leaseExpiresAt > ? ORDER BY updatedAt DESC LIMIT 1` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | Only if no `environmentId` or `hostId` |
| 2   | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?`                     | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` |                                        |
| 3-4 | cursor max + INSERT into `host_daemon_commands`                                                                        | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Transaction                            |

**Total: 3-4 queries. No N+1.**

## Code Reuse

| Function                        | Shared? | Other callers                                          |
| ------------------------------- | ------- | ------------------------------------------------------ |
| `resolveHostId`                 | Shared  | Also used by `system/models` route (file-local helper) |
| `requireEnvironment`            | Shared  | Multiple routes                                        |
| `requireDefaultConnectedHostId` | Shared  | Also used via `resolveHostId` by `system/models`       |
| `queueCommandAndWait`           | Shared  | All daemon-proxying routes                             |

## Flags

> **Updated 2026-03-29:** `hostId` is now validated with a 404 if the host does not exist.

1. ~~**`hostId` query param is not validated** — if you pass a `hostId` that doesn't exist in the `hosts` table, the route will still try to queue a command. The `requireConnectedHostSession` call inside `queueCommandAndWait` will catch this (returns 502 "Host is not connected"), but the error message is misleading — the host doesn't exist at all, not just disconnected.~~ **Fixed** — `hostId` is now validated against the `hosts` table and returns 404 if not found.

## Usages

| Caller                               | Location                                                  | Purpose                                                                         |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `listSystemProviders` API wrapper    | `apps/app/src/lib/api.ts:551`                             | Fetches all providers via `apiClient.system.providers.$get`                     |
| `useSystemProviders` hook            | `apps/app/src/hooks/useApi.ts:704`                        | React Query hook wrapping `listSystemProviders`, 60s stale time                 |
| `useThreadCreationOptions`           | `apps/app/src/hooks/useThreadCreationOptions.ts:277`      | Consumes `useSystemProviders` to populate provider picker in thread creation    |
| `HireManagerModal`                   | `apps/app/src/components/HireManagerModal.tsx:46`         | Consumes `useSystemProviders` to populate provider picker when hiring a manager |
| CLI `provider list`                  | `apps/cli/src/commands/provider.ts:27`                    | Lists providers via `client.api.v1.system.providers.$get`                       |
| `public-environments-system.test.ts` | `apps/server/test/public-environments-system.test.ts:473` | Tests provider listing with `hostId` query                                      |

---

## Review Comments

lets validate the hostId and 404 if hostId is not found.
do any of the callers not pass hostId?

> Done — `hostId` is now validated against the `hosts` table, returning 404 if not found. Callers that don't pass `hostId` fall through to `requireDefaultConnectedHostId` as before.
