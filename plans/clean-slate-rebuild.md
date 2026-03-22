# Clean Slate Rebuild

## Goal

Delete the accumulated service code and rebuild from clean contract boundaries.

## Architectural Principles

### Zod schemas are the source of truth

Every contract package defines Zod schemas for its request and response payloads. Types are derived via `z.infer<>`. No hand-written interfaces that duplicate what a schema already expresses.

### Domain is small but can have Zod

`packages/domain` contains shared vocabulary types used across multiple packages. It can have `zod` as a dependency for types that need validation at multiple boundaries (e.g., `PromptInput`). But it does NOT contain API-specific request/response shapes — those belong in contracts.

### Contracts produce hono clients

Both `server-contract` and `env-daemon-contract` define Hono route types and export `hc()` clients. Route response types reference `z.infer<>` types from schemas — the Endpoint type and the Zod schema are the same definition, not two parallel ones.

### Error responses are part of the contract

Contracts define the error response shape and domain error codes. Clients know exactly what errors look like.

---

## What We Keep

| Package | Notes |
|---------|-------|
| `apps/app` | Code stays. Imports rewritten from `@bb/core` → `@bb/domain` + `@bb/core-ui`. Dependencies updated in package.json. |
| `apps/cli` | Code stays. Imports rewritten from `@bb/core` → `@bb/domain` + `@bb/core-ui`. Also imports from `@bb/environment-daemon` — those need updating or removing. Dependencies updated in package.json. |
| `packages/ui-core` | Untouched |
| `packages/tsconfig` | Untouched |
| `packages/provider-adapters` | Code stays, absorbed into `@bb/agent-runtime` later. See `plans/agent-runtime-package.md`. |
| `packages/templates` | Untouched. Note: `agent-runtime` will depend on this (provider adapters currently import from it). |
| `packages/db` | Keep schema + migrations + connection + ids. Delete repositories. Update dependency from `@bb/core` to `@bb/domain`. |

## What We Delete

| Package/Dir | Replaced by |
|---------|--------|
| `packages/core` | `packages/domain` + `packages/core-ui` shim |
| `packages/environment-daemon` | Rebuilt later from contracts |
| `packages/environment` | Rebuilt later |
| `packages/api-contract` | `packages/server-contract` |
| `packages/env-daemon-contract` | Redefined (daemon's control endpoint contract) |
| `apps/server/src/` | Rebuilt later from contracts |

---

## `packages/domain`

Shared vocabulary types. Small. Zero logic. Can have Zod schemas for types that need validation at multiple boundaries.

**Dependencies:** `zod`

**What belongs here:**

```typescript
// Core entities
Project, Thread, EnvironmentRecord

// Thread state (Thread depends on these)
ThreadStatus, ThreadType, ThreadWorkStatus, ThreadWorkState,
ThreadWorkFileChange, ThreadPrimaryCheckoutState,
ThreadProvisioningReadiness, ThreadProvisioningState,
ThreadQueuedMessage, ThreadBuiltInAction, ThreadBuiltInActionId,
ThreadTurnInitiator, ThreadExecutionOptions

// Events (the canonical event type — used by agent-runtime, server, app)
// Source: core/src/provider-event.ts AND core/src/types.ts
ThreadEvent, ThreadEventType, ThreadEventItem, ThreadEventItemStatus,
ThreadEventRow, ThreadEventData, ThreadEventDataForType,
AppThreadEventType, ThreadEventDataByAppType,
// ... all event data interfaces (SystemErrorEventData,
// ClientOutboundStartEventData, SystemProvisioningStartedEventData, etc.)

// Execution vocabulary (with Zod schemas where needed)
PromptInput (+ promptInputSchema), ReasoningLevel, SandboxMode, ServiceTier

// Provider vocabulary
// Provider ID is `string` — not a closed union. The set of available
// providers is discovered via agent-runtime, not hardcoded in domain.
// ThreadProviderId, THREAD_PROVIDER_IDS, isThreadProviderId are deleted.
ProviderCapabilities, AvailableModel,
ToolCallRequest, ToolCallResponse, DynamicTool

// Environment
EnvironmentDescriptor, EnvironmentProperties, EnvironmentCapabilities

// No utilities in domain. assertNever is used by core-ui code —
// include it in core-ui or inline it in each file.
```

**What does NOT belong here:**

- API request/response shapes (`SpawnThreadRequest`, `SystemHealthReport`, etc.) → `server-contract`
- Session protocol types (`EnvironmentDaemonCommand`, `EnvironmentDaemonEvent`) → `server-contract`
- Daemon control types (`DaemonStatusSnapshot`) → `env-daemon-contract`
- View transforms (`toUIMessages`, `formatTimelineAsText`) → `core-ui` shim
- WebSocket protocol types → `server-contract`
- Runtime contracts (`ThreadOrchestrator`) → server concern

**Note on `Thread`:** `Thread` has `defaultExecutionOptions?: ThreadExecutionOptions`. `ThreadExecutionOptions` lives in domain alongside `Thread`. Note that `ThreadExecutionOptions` also has `approvalPolicy?: string` and `source?: string` — these stay as-is.

**Note on renames:** Current `ProviderToolCallRequest`/`ProviderToolCallResponse`/`ProviderDynamicTool` become `ToolCallRequest`/`ToolCallResponse`/`DynamicTool`. The `Provider` prefix is dropped — these are domain concepts, not provider-specific.

---

## `packages/server-contract`

What the server serves. Two surfaces, one package.

**Dependencies:** `@bb/domain`, `zod`, `hono`

### Zod-first route definitions

Route types reference `z.infer<>` types so the Endpoint definition and the schema are one thing, not two:

```typescript
export const spawnThreadRequestSchema = z.object({ ... });
export type SpawnThreadRequest = z.infer<typeof spawnThreadRequestSchema>;

// Endpoint output types also use z.infer or domain types — never hand-written duplicates
export type PublicApiSchema = {
  "/threads": {
    $post: Endpoint<{ json: SpawnThreadRequest }, Thread, 201>;
    // Thread comes from @bb/domain, SpawnThreadRequest from z.infer above
  };
};
```

### Error responses

```typescript
export const domainErrorCodeSchema = z.enum([
  "invalid_request", "thread_not_found", "project_not_found",
  "thread_archived", "inactive_session", "provider_unavailable",
  "provider_timeout", "provider_rpc_error", "unsupported_operation",
  "no_active_turn", "internal_error",
]);
export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: domainErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
```

### Error status typing for `hc()` clients

For endpoints that return different response types by status code, model each status separately so `hc()` narrows `res.json()` correctly:

```typescript
// Good: hc() narrows by status
"/system/shutdown": {
  $post: Endpoint<{ json: SystemShutdownRequest }, SystemShutdownAcceptedResponse, 200>
       | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownBlockedResponse, 409>;
};
```

### Public API (`/api/v1/*`)

Consumed by `apps/app` and `apps/cli`.

```typescript
export function createPublicApiClient(baseUrl: string) {
  return hc<Hono<{}, PublicApiSchema, "/">>(`${baseUrl}/api/v1`);
}
```

**Owns these types (currently in `@bb/core/api-types.ts`):**
- Request types: `SpawnThreadRequest`, `TellThreadRequest`, `TellThreadMode`, `UpdateProjectRequest`, `CreateProjectRequest`, `UpdateThreadRequest`, `EnqueueThreadMessageRequest`, `SendQueuedThreadMessageRequest`, `ThreadOperationRequest`, `ThreadOperationType`, `EnvironmentOperationRequest`, `EnvironmentOperationType`, `EnvironmentCreationArgs`, `SystemShutdownRequest`, `SystemRestartRequest`, `SystemRestartAction`, `OpenPathRequest`, `OpenThreadPathRequest`
- Response types: `SystemHealthReport` (and all `SystemHealth*` sub-types), `SystemStatus`, `SystemShutdownAcceptedResponse`, `SystemShutdownBlockedResponse`, `SystemShutdownBlockingThread`, `SystemRestartAcceptedResponse`, `SystemRestartPolicy`, `SystemProviderInfo`, `SystemEnvironmentInfo`, `ServerRuntimeMode`, `ThreadTimelineResponse`, `ThreadGitDiffResponse`, `ThreadGitDiffCommitSummary`, `ThreadGitDiffSelection`, `ThreadGitDiffMode`, `ThreadToolGroupMessagesRequest`, `ThreadToolGroupMessagesResponse`, `ThreadContextWindowUsage`, `SendQueuedThreadMessageResponse`, `EnvironmentOperationResponse`, `EnvironmentOperationFailureDetails`, `CommitEnvironmentOperationResponse`, `SquashMergeEnvironmentOperationResponse`, `PrimaryCheckoutStatus`, `PromotePrimaryCheckoutResponse`, `DemotePrimaryCheckoutResponse`, `ProjectFileSuggestion`, `PromptMentionSuggestion`, `UploadedPromptAttachment`
- Operation options: `CommitOperationOptions`, `SquashMergeOperationOptions`
- Open path: `OpenPathTarget`, `OpenPathEditor`

### Internal API (`/internal/*`)

Consumed by env-daemon processes. Bearer token auth.

The daemon depends on `server-contract` to know what the internal API accepts and returns — it's a client of these endpoints.

```typescript
export function createInternalApiClient(baseUrl: string, authToken: string) {
  return hc<Hono<{}, InternalApiSchema, "/">>(`${baseUrl}`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}
```

**Owns the session protocol (currently in `env-daemon-contract/session-protocol.ts`):**
- All session message Zod schemas and `z.infer<>` types
- Session protocol constants, capability negotiation
- `EnvironmentDaemonCommand` and `EnvironmentDaemonEvent` discriminated unions (these flow through the session protocol — the daemon depends on `server-contract` to know what commands it receives)
- Command envelope, ack, delivery state types

### WebSocket protocol

The server also serves a WebSocket. This can't use `hc()` — it needs its own type definitions.

```typescript
// WebSocket message types (from current core/protocol.ts)
export type ClientMessage = SubscribeMessage | UnsubscribeMessage;
export type ServerMessage = ChangedMessage;
// ... change kinds, entity types
```

---

## `packages/env-daemon-contract`

What the env-daemon's HTTP control server serves. The server makes requests TO the daemon.

**Dependencies:** `@bb/domain`, `zod`, `hono`

**The daemon's actual HTTP surface** (from `environment-daemon/http-server.ts`):

```typescript
export type DaemonControlSchema = {
  "/control/status": {
    $post: Endpoint<EmptyInput, DaemonStatusSnapshot>;
  };
  "/control/session-sync": {
    // No request body — triggers a session sync callback.
    // Returns 202 with status snapshot.
    $post: Endpoint<EmptyInput, { ok: true; status: DaemonStatusSnapshot }, 202>;
  };
  "/control/shutdown": {
    // Returns 202
    $post: Endpoint<EmptyInput, { ok: true }, 202>;
  };
};

export function createDaemonControlClient(baseUrl: string, authToken: string) {
  return hc<Hono<{}, DaemonControlSchema, "/">>(`${baseUrl}`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}
```

**Owns these types:**
- `DaemonStatusSnapshot` (currently `EnvironmentDaemonStatusSnapshot` in protocol.ts — renamed)
- Provider spec and connection types (`EnvironmentDaemonProviderSpec`, `EnvironmentDaemonConnectionTarget`)

**Does NOT own:**
- `EnvironmentDaemonCommand` / `EnvironmentDaemonEvent` — these flow through the session protocol (server→daemon via command batches in the internal API). They live in `server-contract`.

---

## `packages/core-ui`

Temporary shim so `apps/app` and `apps/cli` keep working. Cleanup target.

**Dependencies:** `@bb/domain`, `@bb/templates`

**Dependency note:** Some utilities need types that currently live in `api-types.ts`:
- `extractThreadContextWindowUsage` needs `ThreadContextWindowUsage` — move this type to domain (it's a view-layer data shape, not an API request/response)
- `thread-operation-prompts.ts` needs `ThreadOperationRequest` from `api-types.ts` AND `renderTemplate` from `@bb/templates` — these prompts are tightly coupled to server operations. **Move these helpers to `apps/app`** instead of core-ui, since they're only consumed by the app. If CLI also needs them, add `@bb/templates` as a core-ui dependency and move `ThreadOperationRequest` to domain.

**Contains (moved from `packages/core/src/`):**
- `toUIMessages()`, `UIMessage` types
- `buildThreadDetailRows()`, detail row types
- `formatTimelineAsText()`
- `extractThreadContextWindowUsage()`, `ThreadContextWindowUsage` (type stays in core-ui alongside its function)
- `formatEnvironmentDisplay()`, `formatEnvironmentDisplayName()`
- `deriveThreadTitleFromInput()`, `outputFromThreadEvent()`
- `extractErrorMessage()`, `isRecord()` (still needed for error handling)

**Does NOT contain:**
- `buildCommitFailureFollowUpInstruction()`, squash-merge prompts — these depend on `@bb/templates` and server operation types. Move to `apps/app` directly.

**Tests:** Migrate existing test suites alongside the code:
- `to-ui-messages.test.ts` → `packages/core-ui/test/`
- `thread-detail-rows.test.ts` → `packages/core-ui/test/`
- `format-timeline-text.test.ts` → `packages/core-ui/test/`
These are canonical view behavior tests. They must pass after migration.

---

## Migration Steps

Broken codebase is fine. No backward compat.

### Step 1: Create `packages/domain`

Small package. Shared entity types, enums, event types, execution vocabulary. Has `zod` dependency for schemas like `promptInputSchema`. Zero other workspace dependencies.

### Step 2: Create `packages/server-contract`

- Define Zod schemas for all public API request/response payloads, derive types via `z.infer<>`
- Define `PublicApiSchema` route type with Endpoint output types referencing `z.infer<>` / domain types
- `createPublicApiClient()` with `hc()`
- Move session protocol schemas from current `env-daemon-contract/session-protocol.ts`
- Move `EnvironmentDaemonCommand`/`Event` from `environment-daemon/protocol.ts` (NOT from env-daemon-contract — they live in the daemon package)
- Define `InternalApiSchema` route type, `createInternalApiClient()` with `hc()`
- Define error response schema and domain error codes
- Define WebSocket protocol types

### Step 3: Redefine `packages/env-daemon-contract`

- Define the daemon's actual control endpoint routes (status, session-sync, shutdown)
- Match real HTTP surface: no request body on session-sync, 202 status codes
- Zod schemas for control responses
- `createDaemonControlClient()` with `hc()`

### Step 4: Create `packages/core-ui` shim

- Move view utilities and their tests from `packages/core`
- Verify migrated tests pass

### Step 5: Update consumers

- Update `apps/app` and `apps/cli` imports from `@bb/core` to `@bb/domain` / `@bb/core-ui` / `@bb/server-contract`
- Update `packages/db` dependency from `@bb/core` to `@bb/domain`, rewrite imports in schema.ts
- Goal: all import paths point to new packages. Some files may still have type errors if the new packages don't export exactly the same shapes — that's acceptable.

### Step 6: Delete

- `apps/server/src/` (keep `apps/server/package.json` as placeholder)
- `packages/environment-daemon/` entirely
- `packages/environment/` entirely
- `packages/core/` entirely
- `packages/api-contract/` entirely
- Repository layer from `packages/db` (`repositories.ts`, `environment-daemon-repositories.ts`, `test/`)

This plan ends at Step 5. Rebuilding services (`server`, `env-daemon`, `agent-runtime`, `logger`, `env`) is a separate effort — see `plans/agent-runtime-package.md` for the agent-runtime spec.

---

## Dependency Graph

```
                      domain (zod)
                     /      |         \
           server-contract  |  env-daemon-contract
            (domain, zod,   |   (domain, zod, hono)
             hono)          |
            / |  \          |
    core-ui  |   \          |
 (domain,    |    \         |
  templates) |     \        |
    /    \   |      \       |
apps/app  apps/cli   \      |
  (domain, core-ui,   \     |
   server-contract)    \    |
                        \   |
                     env-daemon (rebuilt later)
                      (server-contract, env-daemon-contract,
                       domain, agent-runtime)

  agent-runtime (later)     db (kept)
   (domain, templates)       (domain)
```

Note: `provider-adapters` currently depends on `@bb/core`. During Step 5 (delete core),
provider-adapters will break. It stays broken until Step 6 when it's absorbed into
`agent-runtime` (which depends on `domain`, not `core`). This is expected.

---

## Scope

This plan covers Steps 1-6 only: create contract packages, migrate view utilities, update consumers, delete old code. Rebuilding services is a separate plan.

**In scope:**
- Create `domain`, `server-contract`, `env-daemon-contract`, `core-ui`
- Update import paths in `apps/app`, `apps/cli`, `packages/db`
- Delete `core`, `environment-daemon`, `environment`, `api-contract`, `apps/server/src/`, db repositories

**Out of scope:**
- Rebuilding the server, env-daemon, or environment provisioning
- Creating `agent-runtime`, `logger`, `env`
- Fixing `provider-adapters` (stays broken until absorbed)
- Making `apps/app` and `apps/cli` fully typecheck (import paths correct, type errors acceptable)

## Validation

**After Steps 1-6, these should be true:**
- `packages/domain` typechecks (depends on `zod`)
- `packages/server-contract` typechecks (depends on `domain`, `zod`, `hono`)
- `packages/env-daemon-contract` typechecks (depends on `domain`, `zod`, `hono`)
- `packages/core-ui` typechecks AND tests pass (depends on `domain`, `templates`)
  - `to-ui-messages.test.ts` passes
  - `thread-detail-rows.test.ts` passes
  - `format-timeline-text.test.ts` passes
- `packages/db` typechecks (depends on `domain`)
- `apps/app` and `apps/cli` have all import paths updated (Step 5). Type errors from shape mismatches are acceptable; broken import paths are not.

**These will be broken (expected):**
- `apps/server` — deleted, placeholder only
- `packages/provider-adapters` — depends on deleted `@bb/core`
- `apps/app` and `apps/cli` — type errors acceptable, import paths must be correct
- All root workspace scripts (`pnpm build`, `pnpm dev`, etc.) — expected to fail

## Resolved Questions

- **`buildCommitFailureFollowUpInstruction`**: Moves to `apps/app` (not core-ui). Depends on `@bb/templates` and server operation types — too coupled for core-ui.
- **CLI imports from `@bb/environment-daemon`**: CLI DOES import from it — `apps/cli/src/commands/environment-daemon.ts` imports `resolveEnvironmentDaemonServiceOptions` and `startEnvironmentDaemonService`. This file manages the daemon lifecycle from the CLI. After deletion, these imports break — the CLI command file will need to be stubbed or removed in Step 6.
- **`ThreadContextWindowUsage`**: Moves to domain alongside `extractThreadContextWindowUsage` in core-ui.
- **`ProviderCapabilities` / `AvailableModel`**: Stay in domain despite originating from `api-types.ts` — they're genuinely shared vocabulary used by agent-runtime.
- **WebSocket types**: Plain TypeScript types in server-contract, no Zod schemas. WebSocket messages are simple enough that runtime validation isn't needed. This is an explicit exception to "Zod is source of truth."
- **`@bb/templates` dependency chain**: `@bb/templates` has zero workspace dependencies. Has `gray-matter` and `handlebars` as production deps, `esbuild` as dev dep. Safe to keep.

## Open Questions

None. Implementation concerns (how the server/daemon use the contracts) are deferred to Step 6.
