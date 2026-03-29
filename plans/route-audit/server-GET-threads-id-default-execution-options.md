# `GET /api/v1/threads/:id/default-execution-options` — Last Used Execution Options

**Route:** `apps/server/src/routes/threads/data.ts:87`
**Contract:** `PathId -> ResolvedThreadExecutionOptions | null` (200)
**Complexity:** Medium

## Request Params

| Field | Required | Notes                                                                                                                            |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `:id` | Yes      | Thread ID. Passed directly to `getLastExecutionOptions` -- **no `requireThread` guard**, returns `null` for nonexistent threads. |

**All 1 field consumed. No dead params.**

## Implementation Trace

1. **Sync** `getLastExecutionOptions(deps, threadId)` (`services/thread-events.ts:244`):
   - Queries `events` table: `WHERE threadId = ? AND type IN ('client/thread/start', 'client/turn/requested', 'client/turn/start') ORDER BY sequence DESC LIMIT 1`.
   - If no row found, returns `null`.
   - If row found, calls `parseStoredTurnRequestEvent(row)`:
     - JSON.parses `row.data`.
     - Validates with `turnRequestEventDataSchema`.
     - Throws `ApiError(500, ...)` on parse failure.
   - Returns `parsed.execution` -- the `ResolvedThreadExecutionOptions` object (model, serviceTier, reasoningLevel, sandboxMode, providerId, etc.).

> **-> HTTP 200 returns here.** Fully synchronous.

## DB Query Summary

| #   | Query                                                                                                                   | Table  | Index                                            | Notes                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | `SELECT data, sequence, threadId, type FROM events WHERE threadId = ? AND type IN (...) ORDER BY sequence DESC LIMIT 1` | events | `events_thread_sequence_idx(threadId, sequence)` | Uses threadId prefix. The `type IN` filter is applied post-index. Only fetches 1 row. |

**Total: 1 query. No N+1.**

## Code Reuse

| Function                      | Shared with                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| `getLastExecutionOptions`     | Only used here                                                   |
| `parseStoredTurnRequestEvent` | Used internally by thread-events module for turn request parsing |

## Flags

> **Updated 2026-03-29:** `requireThread` guard added.

1. ~~**No `requireThread` guard.** Returns `null` for nonexistent threads instead of 404. Same pattern as `/output` and `/events`. Inconsistent with `/timeline`.~~ **Fixed** — `requireThread` guard added, now returns 404 for nonexistent threads.
2. **Note:** `deps` (full `AppDeps`) is passed to `getLastExecutionOptions` but only `deps.db` is used. The function signature is `Pick<AppDeps, "db">` which is fine, but the route passes the full deps object.

## Usages

| Caller                                                | Location                                                  | Purpose                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `getThreadDefaultExecutionOptions` (API client)       | `apps/app/src/lib/api.ts:370`                             | Fetches last-used execution options from the server                                                               |
| `useThreadDefaultExecutionOptions` (React query hook) | `apps/app/src/hooks/useApi.ts:541`                        | Wraps the API call in a `useQuery` hook                                                                           |
| `ThreadDetailView`                                    | `apps/app/src/views/ThreadDetailView.tsx:237`             | Calls `useThreadDefaultExecutionOptions` to pre-populate model/tier/reasoning/sandbox selectors for the next turn |
| Server route tests                                    | `apps/server/test/public-thread-data.test.ts:183,317,387` | Direct HTTP requests to `/api/v1/threads/:id/default-execution-options`                                           |
| Contract route definition                             | `packages/server-contract/src/public-api.ts:248`          | Typed route definition for `/threads/:id/default-execution-options`                                               |

---

## Review Comments

<!-- Flag #1: consider adding requireThread for consistency. Flag #2 is minor/cosmetic. -->

lets add requireThread

> Done — `requireThread(db, id)` guard added before `getLastExecutionOptions`. Returns 404 for nonexistent threads.

flag 2 is fine. leave it as is.

> Acknowledged — no change.
