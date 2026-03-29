# `GET /api/v1/environments/:id` — Get Single Environment

**Route:** `apps/server/src/routes/environments.ts:36`
**Contract:** `PathId -> Environment` (200) | `PathId -> ApiError` (404)
**Complexity:** Simple CRUD

## Request Body (or Params)

| Field        | Required | Notes                                      |
| ------------ | -------- | ------------------------------------------ |
| `:id` (path) | Yes      | Environment ID. Used for direct PK lookup. |

**All 1 field consumed. No dead params.**

## Implementation Trace

1. (sync) `requireEnvironment(deps.db, id)` called.
   - Calls `getEnvironment(db, id)` — `SELECT * FROM environments WHERE id = ?`.
   - If `null`, throws `ApiError(404, "environment_not_found")`.
   - Returns the `Environment` row directly.

> **-> HTTP 200 returns here.** Fully synchronous.

## DB Query Summary

| #   | Query                                     | Table          | Index | Notes |
| --- | ----------------------------------------- | -------------- | ----- | ----- |
| 1   | `SELECT * FROM environments WHERE id = ?` | `environments` | PK    |       |

**Total: 1 query. No N+1.**

## Code Reuse

| Function             | Shared? | Other callers                                                              |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `requireEnvironment` | Shared  | Used by status, diff, actions routes, and `resolveHostId` in system routes |

## Flags

None. Clean CRUD.

## Usages

| Caller                               | Location                                                 | Purpose                                                                 |
| ------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `getEnvironment` API wrapper         | `apps/app/src/lib/api.ts:446`                            | Fetches a single environment by ID                                      |
| `useEnvironment` hook                | `apps/app/src/hooks/useApi.ts:579`                       | React Query hook wrapping `getEnvironment`                              |
| `ThreadDetailView`                   | `apps/app/src/views/ThreadDetailView.tsx:311`            | Fetches the thread's environment for display and actions                |
| CLI `thread show`                    | `apps/cli/src/commands/thread/show.ts:134`               | Fetches the thread's environment to get `defaultBranch` for status/diff |
| CLI `status`                         | `apps/cli/src/commands/status.ts:88`                     | Fetches environment for each thread to build status display             |
| `getEnvironment` test helper         | `tests/integration/helpers/api.ts:209`                   | Integration test helper wrapping `api.environments[":id"].$get`         |
| `readEnvironment` assertion helper   | `tests/integration/helpers/assertions.ts:85`             | Reads environment during assertions (e.g. `waitForEnvironmentReady`)    |
| `requireMergeBaseBranch` test helper | `tests/integration/helpers/api.ts:105`                   | Fetches environment to resolve `defaultBranch` for status/diff calls    |
| `smoke.test.ts`                      | `tests/integration/fake/smoke.test.ts:106`               | Multiple calls verifying environment state after provisioning           |
| `multi-thread.test.ts`               | `tests/integration/fake/multi-thread.test.ts:243`        | Verifies environment state in multi-thread scenarios                    |
| `provider-smoke.test.ts`             | `tests/integration/real/provider-smoke.test.ts:448`      | Verifies environment state in real provider tests                       |
| `integration.test.ts`                | `apps/server/test/integration.test.ts:200`               | Server unit test for environment GET                                    |
| `public-environments-system.test.ts` | `apps/server/test/public-environments-system.test.ts:80` | Tests 404 and success responses                                         |

---

## Review Comments

would it make sense to fold this into environment/:id/status - are there callers that use this without also calling status?

> Not actioned yet — left as-is. Multiple callers (CLI `thread show`, CLI `status`, integration test helpers) use this route independently of `/status`. Folding would require all callers to pass a `mergeBaseBranch` query param even when they only need the environment record.
