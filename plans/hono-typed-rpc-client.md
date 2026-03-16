# Hono Typed RPC Client Migration

## Goal

Replace the hand-rolled `fetch`-based API client (`apps/app/src/lib/api.ts`) with Hono's typed RPC client (`hc`), so that every frontend API call is type-checked against the actual server route definitions at compile time. This eliminates field-name mismatches like the `environmentId` vs `environmentKind` bug.

## Scope

- **In scope:** All 52 JSON endpoints in `apps/app/src/lib/api.ts` that use the `request<T>()` helper.
- **Partially in scope:** File upload endpoints (2) — need a thin wrapper since `hc` doesn't natively handle multipart; the types still flow.
- **Out of scope:** WebSocket (`apps/app/src/lib/ws.ts`) — Hono RPC has no WebSocket support; stays manual. The env-daemon session endpoints under `/threads/:id/env-daemon/` are only used by the environment agent, not the app client.

## Current State

- **Server routes** already use chained `.get()/.post()` on `new Hono()`, so the full route type is preserved through the chain.
- **`AppType`** is already exported from `@bb/server/app-type` (see `apps/server/src/app-type.ts` and `apps/server/package.json` exports).
- **Zod validators** are already wired via `@hono/zod-validator` on most mutation routes — `hc` infers request body types from these.
- **`apps/app`** does not currently depend on `@bb/server`; a type-only dependency needs to be added.

## Implementation Steps

### 1. Add `@bb/server` as a dev dependency of `apps/app`

```jsonc
// apps/app/package.json
"devDependencies": {
  "@bb/server": "workspace:*",  // type-only — no runtime import
  ...
}
```

Run `pnpm install` to link the workspace. Verify `import type { AppType } from "@bb/server/app-type"` resolves in `apps/app`.

### 2. Audit server routes for type completeness

Hono RPC infers types from:
- **Request body:** Inferred from `zValidator("json", schema)` — already present on most mutations.
- **Query parameters:** Inferred from `zValidator("query", schema)` — **currently missing** on most GET endpoints that accept query params. These need to be added.
- **Response body:** Inferred from `c.json(...)` return type.

**Action items:**

a. **Add `zValidator("query", ...)` to GET endpoints that accept query params.** Key ones:
   - `GET /threads` — `projectId`, `parentThreadId`, `includeArchived`, `includeWorkStatus`
   - `GET /threads/:id/timeline` — `limit`, `includeToolGroupMessages`, `includeManagerDebugView`
   - `GET /threads/:id/work-status` — `mergeBaseBranch`
   - `GET /threads/:id/git-diff` — `selection`, `mergeBaseBranch`
   - `GET /threads/:id/tool-group-messages` — `limit`, `messageId`
   - `GET /system/models` — `providerId`
   - `GET /projects/:id/files` — `query`, `limit`
   - `GET /environments` — `projectId`

b. **Ensure all `c.json(...)` calls use typed return values** (most already do via explicit types, but verify none use `as any` or untyped objects).

c. **Handle non-JSON responses.** Two patterns exist:
   - `c.body(null, 204)` — env-daemon session endpoints (out of scope for app client)
   - `c.body(bytes)` — `GET /projects/:id/attachments/:attachmentId/content` (binary download)

   For binary endpoints, `hc` will infer `Response` — the client can call `.blob()` or `.arrayBuffer()` manually.

### 3. Create the typed client module

Create `apps/app/src/lib/api-client.ts`:

```typescript
import { hc } from "hono/client";
import type { AppType } from "@bb/server/app-type";

// Base URL — same as current BASE in api.ts
const BASE_URL = window.location.origin;

export const client = hc<AppType>(BASE_URL);

// Convenience alias for the API routes
export const api = client.api.v1;
```

### 4. Migrate endpoints incrementally (by resource group)

Migrate one route group at a time, replacing the hand-rolled functions in `api.ts` with calls through the typed client. After each group, run `pnpm exec turbo run typecheck --filter=@bb/app` to catch any mismatches.

**Migration order** (least to most complex):

#### Phase A: System routes (~10 endpoints)
Simplest endpoints, mostly GETs with few/no parameters. Good for validating the approach.

- `getSystemStatus`, `getSystemProvider`, `listSystemProviders`, `listSystemEnvironments`, `getSystemRestartPolicy`, `getAvailableModels`, `pickProjectFolder`
- `shutdownDaemon`, `restartDaemon` — have custom 409 handling; wrap `hc` call with same error handling
- `transcribeVoiceInput` — file upload; use `hc` for type checking the URL but keep manual `fetch` for multipart body

#### Phase B: Environment routes (~2 endpoints)
- `listEnvironments`

#### Phase C: Project routes (~8 endpoints)
- Standard CRUD: `createProject`, `listProjects`, `updateProject`, `deleteProject`, `getProjectWorkspaceStatus`, `searchProjectFiles`, `hireProjectManager`
- `uploadPromptAttachment` — file upload; same approach as transcription

#### Phase D: Thread routes (~30 endpoints)
Largest group. Migrate in sub-batches:
1. Basic CRUD: `spawnThread`, `getThread`, `listThreads`, `updateThread`, `deleteThread`
2. Lifecycle: `tellThread`, `stopThread`, `archiveThread`, `unarchiveThread`, `markThreadRead/Unread`
3. Queue: `enqueueThreadMessage`, `sendQueuedThreadMessage`, `deleteQueuedThreadMessage`
4. Status/Data: `getThreadTimeline`, `getThreadWorkStatus`, `getThreadOutput`, `getThreadGitDiff`, etc.
5. Operations: `requestThreadOperation`, `promoteThread`, `demotePrimaryCheckout`, `openThreadPathInEditor`

### 5. Update React Query hooks

In `apps/app/src/hooks/useApi.ts`, update mutation/query functions to call the new typed client instead of the old `api.*` functions. The hook signatures stay the same — only the internal implementation changes.

### 6. Handle file uploads

Hono RPC doesn't support multipart natively. For the 2 upload endpoints:
- Keep a thin `uploadFile(url, file)` helper.
- Use the typed client to derive the URL (e.g., `client.api.v1.projects[":id"].attachments.$url({ param: { id } })`), but send the body via manual `fetch`.
- This gives type-safe URLs while keeping multipart working.

### 7. Handle custom error responses

The current `throwHttpError` helper reads the JSON error body and throws a typed error. With `hc`, responses are returned as `Response` objects when using `$<method>()`. Wrap the client to check `res.ok` and throw the same error type for backward compatibility with existing error handling in hooks and components.

### 8. Remove old api.ts

Once all endpoints are migrated and the typecheck + tests pass, delete the hand-rolled functions from `api.ts`. Keep only the error handling utilities and the `BASE` constant if still needed.

## Validation

- `pnpm exec turbo run typecheck --filter=@bb/app` — must pass after each phase
- `pnpm exec turbo run typecheck --filter=@bb/server` — must pass after query validator additions
- `pnpm exec turbo run test --filter=@bb/server` — must pass (route tests)
- Manual smoke test: spawn a thread from the project main view, send a follow-up, verify all dropdowns and submit work
- Verify no runtime `hono/client` bundle size regression — `hc` is lightweight but confirm via build output

## Open Questions / Risks

1. **Bundle size:** `hono/client` is small (~2KB), but verify it doesn't pull in server-only code. The `import type` for `AppType` is erased at compile time, but the `hc` runtime import must be tree-shakeable.
2. **Query parameter typing:** Some GET endpoints use `c.req.query()` without Zod validation. Adding `zValidator("query", ...)` changes the handler signature slightly — need to verify existing tests still pass.
3. **Multipart uploads:** The file upload pattern (typed URL + manual fetch) is a bit awkward. Could consider `@hono/zod-validator` for multipart schemas in the future.
4. **Env-daemon session endpoints:** These are called by the environment agent process, not the app. They use patterns like `c.body(null, 204)` that don't map cleanly to `hc`. Leave them out of the typed client.
5. **Path parameters:** Hono RPC uses `{ param: { id: "..." } }` syntax. Need to update all call sites — the migration is mechanical but touches many files in `useApi.ts`.
