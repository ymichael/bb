# Clean Slate Rebuild

## Goal

Delete the accumulated service code and rebuild from clean contract boundaries. The current server/daemon code suffers from architectural drift, a 6000-line orchestrator, blurry service boundaries, and type hacks throughout. Instead of continuing to patch it, start fresh with well-defined package boundaries and rebuild services on top.

## What We Keep

| Package | Keep | Notes |
|---------|------|-------|
| `apps/app` | Yes | Frontend, untouched |
| `apps/cli` | Yes | CLI client, untouched |
| `packages/ui-core` | Yes | Shared UI primitives |
| `packages/tsconfig` | Yes | Build config |
| `packages/provider-adapters` | Absorbed into `@bb/agent-runtime` | Code stays, package boundary redesigned. See `plans/agent-runtime-package.md` for the new public API and adapter interface. |
| `packages/templates` | Yes | Mostly markdown |
| `packages/db` | Schema only | Keep drizzle schema + migrations + connection + ids. Delete repositories. |
| `qa/` | Consolidate | Fold into single `qa/README.md` describing all features to QA |

## What We Delete

| Package/Dir | Reason |
|---------|--------|
| `packages/core` | Replaced by `packages/domain` + `packages/core-ui` shim. Core mixes domain types, UI formatting, event rendering, Zod request schemas, runtime contracts, and helpers. |
| `packages/environment-daemon` | Rebuilt later. Protocol types move to contracts, runtime rebuilt from scratch. |
| `packages/environment` | Rebuilt later. Provisioning strategies, git workspace management. |
| `packages/api-contract` | Replaced by `packages/server-contract` |
| `packages/env-daemon-contract` | Redefined — becomes the daemon's own HTTP server contract, not the session protocol (session protocol moves to `server-contract`) |
| `apps/server/src/` | Rebuilt later from contracts |

## New Package Architecture

```
packages/
├── domain/                  # Pure types — zero logic, zero dependencies
├── core-ui/                 # Shim: view transforms from old core (cleanup target)
├── server-contract/         # What the server serves (HTTP contract)
├── env-daemon-contract/     # What the env-daemon serves (HTTP contract)
├── agent-runtime/           # Provider process management (replaces provider-adapters)
├── db/                      # Drizzle schema + migrations (no repositories)
├── templates/               # Markdown templates (keep)
├── ui-core/                 # Shared UI (keep)
└── tsconfig/                # Build config (keep)

apps/
├── app/                     # Frontend (keep)
├── cli/                     # CLI (keep)
└── server/                  # Rebuilt later from contracts
```

---

### `packages/domain`

Pure domain types. No logic, no utilities, no formatting, no Zod schemas. Just TypeScript interfaces and type unions that describe the domain.

**Zero dependencies.**

**Source files to create (extracted from `packages/core/src/`):**

| New file | Source | What moves |
|----------|--------|-----------|
| `src/project.ts` | `core/src/types.ts` | `Project` |
| `src/environment.ts` | `core/src/types.ts` | `EnvironmentDescriptor`, `EnvironmentLocation`, `EnvironmentWorkspaceKind`, `EnvironmentProperties`, `EnvironmentRecord`, `PersistedEnvironmentRecord`, `EnvironmentCapability`, `EnvironmentCapabilities` |
| `src/thread.ts` | `core/src/types.ts` | `Thread`, `ThreadStatus`, `ThreadType`, `ThreadWorkState`, `ThreadWorkStatus`, `ThreadWorkFileChange`, `ThreadPrimaryCheckoutState`, `ThreadProvisioningReadiness`, `ThreadProvisioningState`, `ThreadQueuedMessage`, `ThreadBuiltInAction`, `ThreadBuiltInActionId`, `ThreadTurnInitiator` |
| `src/thread-event.ts` | `core/src/types.ts` + `core/src/provider-event.ts` | `ThreadEventRow`, `ThreadEventData`, `ThreadEventDataForType`, `ThreadEventDataByAppType`, `AppThreadEventType`, `ThreadEventOfType`, all event data interfaces (`SystemErrorEventData`, `ClientOutboundStartEventData`, etc.), `ThreadEvent`, `ThreadEventType`, `ThreadEventItem`, `ThreadEventItemStatus`, etc. |
| `src/execution.ts` | `core/src/shared-types.ts` + `core/src/api-types.ts` | `ReasoningLevel`, `SandboxMode`, `ServiceTier`, `PromptInput`, `ModelReasoningEffort`, `ThreadExecutionOptions`, `ClientExecutionOptionsSnapshot` |
| `src/operations.ts` | `core/src/api-types.ts` | `CommitOperationOptions`, `SquashMergeOperationOptions`, `ThreadOperationRequest`, `EnvironmentOperationRequest`, `CommitEnvironmentOperationResponse`, `SquashMergeEnvironmentOperationResponse`, `EnvironmentOperationFailureDetails`, `EnvironmentOperationResponse`, `PrimaryCheckoutStatus`, `PromotePrimaryCheckoutResponse`, `DemotePrimaryCheckoutResponse` |
| `src/system.ts` | `core/src/api-types.ts` | `SystemStatus`, `SystemHealthReport`, `SystemHealthStorageBucket`, `SystemHealthDiskSummary`, `SystemHealthThreadCounts`, `SystemHealthEnvironmentDaemon*`, `ServerRuntimeMode`, `SystemProviderInfo`, `SystemEnvironmentInfo`, `SystemRestartPolicy`, `SystemRestartRequest`, `SystemRestartAcceptedResponse`, `SystemShutdownRequest`, `SystemShutdownAcceptedResponse`, `SystemShutdownBlockedResponse`, `SystemShutdownBlockingThread`, `AvailableModel` |
| `src/api-requests.ts` | `core/src/api-types.ts` | `SpawnThreadRequest`, `TellThreadRequest`, `EnqueueThreadMessageRequest`, `SendQueuedThreadMessageRequest`, `SendQueuedThreadMessageResponse`, `UpdateThreadRequest`, `CreateProjectRequest`, `UpdateProjectRequest`, `EnvironmentCreationArgs`, `OpenPathTarget`, `OpenPathEditor`, `OpenPathRequest`, `OpenThreadPathRequest`, `ProjectFileSuggestion`, `PromptMentionSuggestion`, `UploadedPromptAttachment`, `ThreadToolGroupMessagesRequest`, `ThreadToolGroupMessagesResponse`, `ThreadContextWindowUsage`, `ThreadTimelineResponse`, `ThreadGitDiffCommitSummary`, `ThreadGitDiffSelection`, `ThreadGitDiffMode`, `ThreadGitDiffResponse` |
| `src/provider.ts` | `core/src/thread-provider.ts` + `core/src/runtime-contracts.ts` | `ThreadProviderId`, `THREAD_PROVIDER_IDS`, `DEFAULT_THREAD_PROVIDER_ID`, `isThreadProviderId`, `ProviderCapabilities`, `ProviderToolCallRequest`, `ProviderToolCallResponse` |
| `src/protocol.ts` | `core/src/protocol.ts` | `RealtimeEntity`, `ThreadChangeKind`, `SystemChangeKind`, `THREAD_CHANGE_KINDS`, `SYSTEM_CHANGE_KINDS`, `SubscribeMessage`, `UnsubscribeMessage`, `ClientMessage`, `ChangedMessage`, `ServerMessage` |
| `src/assert-never.ts` | `core/src/assert-never.ts` | `assertNever` (pure utility, no deps) |
| `src/index.ts` | — | Re-exports everything |

**Does NOT contain:**
- Zod schemas (go in contract packages)
- `toUIMessages()`, `formatTimelineAsText()`, `buildThreadDetailRows()` (go in `core-ui` shim)
- `unknown-helpers.ts` (eliminated)
- `runtime-contracts.ts` `ThreadOrchestrator`, `SchedulerService` etc. (server concerns, rebuilt later)
- `schemas.ts` (`promptInputSchema` etc. — go in `server-contract`)
- `storage-paths.ts` (server concern)

---

### `packages/core-ui`

Temporary shim package so `apps/app` and `apps/cli` keep compiling after `packages/core` is deleted. This is a cleanup target, not a permanent home.

**Dependencies:** `packages/domain`, `zod`

**Files to move from `packages/core/src/`:**

| File | What it provides | Used by |
|------|-----------------|---------|
| `ui-message.ts` | `UIMessage` and all subtypes (`UIUserMessage`, `UIAssistantTextMessage`, `UIToolCallMessage`, etc.) | app |
| `to-ui-messages.ts` | `toUIMessages()` — transforms `ThreadEvent[]` → `UIMessage[]` | app |
| `thread-detail-rows.ts` | `ThreadDetailRow`, `ThreadDetailMessageRow`, `ThreadDetailToolGroupRow`, `buildThreadDetailRows()` | app |
| `format-timeline-text.ts` | `formatTimelineAsText()`, `TimelineFormat` | app, cli |
| `thread-context-window-usage.ts` | `extractThreadContextWindowUsage()` | app |
| `environment-display.ts` | `formatEnvironmentDisplay()`, `EnvironmentDisplayInfo` | app |
| `environment-display-name.ts` | `formatEnvironmentDisplayName()`, `formatRuntimeKind()`, `isWorktreeEnvironmentReference()` | app |
| `thread-operation-prompts.ts` | `buildCommitFailureFollowUpInstruction()`, `buildSquashMergeCommitFailureFollowUpInstruction()`, `buildSquashMergeConflictFollowUpInstruction()` | app |
| `provider-event-utils.ts` | `deriveThreadTitleFromInput()`, `outputFromThreadEvent()` | app |
| `unknown-helpers.ts` | `extractErrorMessage()`, `isRecord()`, `toRecord()` — still used by app and cli for error handling | app, cli |
| `schemas.ts` | `promptInputSchema` — used by app for input validation | app |

---

### `packages/server-contract`

The complete HTTP contract for the server. Two surfaces.

**Dependencies:** `packages/domain`, `zod`, `hono`

**Contains:**

1. **Public API schema** (from current `packages/api-contract/src/schema.ts`)
   - All route definitions: projects, threads, environments, system
   - `createPublicApiClient(baseUrl)` using `hc()`

2. **Internal session API schema** (from current `packages/env-daemon-contract/src/session-protocol.ts`)
   - Session protocol Zod schemas (open, welcome, heartbeat, event batch, event ack, command batch, command ack, command result, provider request/response, close, replaced)
   - Types derived from schemas via `z.infer<>`
   - Session protocol constants, capability negotiation helpers, type guards
   - Internal route definitions
   - `createInternalApiClient(baseUrl, authToken)` using `hc()` or typed client class

3. **Session HTTP client** (from current `packages/env-daemon-contract/src/client.ts`)
   - `EnvironmentDaemonSessionClient` — typed HTTP client for daemon→server session communication
   - Response validation via Zod schemas

4. **WebSocket protocol** (from current `packages/core/src/protocol.ts`)
   - `ClientMessage`, `ServerMessage`, `ChangedMessage` — realtime subscription types
   - Note: types also in `domain/protocol.ts`, but Zod schemas for validation go here

**Source material:**
- `packages/api-contract/src/schema.ts` → public route types
- `packages/api-contract/src/index.ts` → `createApiClient()` pattern
- `packages/env-daemon-contract/src/session-protocol.ts` → session schemas + types
- `packages/env-daemon-contract/src/client.ts` → session HTTP client
- `packages/env-daemon-contract/src/index.ts` → exports

---

### `packages/env-daemon-contract`

The HTTP contract for the environment daemon's control endpoint. The server makes requests TO the daemon.

**Dependencies:** `packages/domain`, `zod`, `hono`

**Source material** (from current `packages/environment-daemon/src/protocol.ts`):

| What | Source |
|------|--------|
| `EnvironmentDaemonCommand` | Discriminated union of all command types (provider.ensure, thread.start, thread.resume, thread.stop, turn.run, thread.rename, provider.list_models, provider.list_catalog, workspace.status, workspace.diff) |
| `EnvironmentDaemonEvent` | Discriminated union of all event types (environment.ready/degraded, thread.started/stopped, turn.started/completed, provider.event/stderr/rpc_error, workspace.status.changed) |
| `EnvironmentDaemonCommandEnvelope` | Command metadata wrapper |
| `EnvironmentDaemonCommandAck` | Command delivery acknowledgement + `getProviderThreadIdFromCommandResult()` |
| `EnvironmentDaemonStatusSnapshot` | Daemon status reporting |
| `EnvironmentDaemonControlRequest` | Control message union (command, provider.ensure, status) |
| `EnvironmentDaemonControlResponse` | Control response union |
| Provider/connection types | `EnvironmentDaemonProviderSpec`, `EnvironmentDaemonConnectionTarget`, `EnvironmentDaemonServerConnectionConfig` |
| Zod command schemas | All command validation schemas (currently in `protocol.ts`) |
| `createDaemonControlClient()` | hc() client for control endpoint |

---

## Migration Strategy

Broken codebase during migration is fine. Typecheck passing at the end is nice but not required.

### Step 1: Create `packages/domain`

Extract pure types from `packages/core` into `packages/domain` using the file mapping above. Create `package.json` (zero dependencies), `tsconfig.json`, and `src/index.ts` that re-exports all type files.

### Step 2: Create `packages/server-contract`

Merge `packages/api-contract` and the session protocol from `packages/env-daemon-contract` into one package. Create public API + internal API route types, hc() clients, Zod schemas.

### Step 3: Create `packages/env-daemon-contract` (redefined)

Extract daemon control endpoint types from `packages/environment-daemon/src/protocol.ts`. Create Zod schemas for control requests/responses. Create hc() client.

### Step 4: Create `packages/core-ui` shim

Move view utilities from `packages/core` into `packages/core-ui` using the file list above. Update `apps/app` and `apps/cli` imports from `@bb/core` to `@bb/domain` (for types) and `@bb/core-ui` (for view utilities).

### Step 5: Delete

- Delete `apps/server/src/` (keep `apps/server/package.json` as placeholder)
- Delete `packages/environment-daemon/` entirely
- Delete `packages/environment/` entirely
- Delete `packages/core/` entirely
- Delete `packages/api-contract/` entirely
- Delete `packages/db/src/repositories.ts` and `packages/db/src/environment-daemon-repositories.ts` (keep `schema.ts`, `connection.ts`, `ids.ts`, `migrate.ts`, `index.ts`)
- Delete `packages/db/test/` (repository tests)

### Step 6 (later): Rebuild

- Rebuild `apps/server` from contracts — small, focused services
- Rebuild environment daemon runtime (uses `@bb/agent-runtime` for provider sessions)
- Rebuild environment provisioning
- Create `packages/agent-runtime` from `provider-adapters` code — see `plans/agent-runtime-package.md`
- Create `packages/logger` and `packages/env`
- Clean up `packages/core-ui` shim — move view logic to proper homes

## Decisions

- **`toUIMessages` / view transforms**: Shim package `core-ui` for now. Not worth designing the right home until services are rebuilt.
- **WebSocket protocol types**: Live in `packages/domain/src/protocol.ts` (the types). Validation schemas go in `server-contract`.
- **`PromptInput` Zod schema**: Goes in `server-contract` — schemas belong at contract boundaries.
- **Logger / env packages**: Deferred to Step 6. Get boundaries in place first.
- **Phasing**: Delete before rebuild. Broken codebase is acceptable.
- **No backward compat**: No re-export shims, no legacy aliases. Clean break.

## Dependency Graph

```
                    domain (zero deps)
                   /      |          \
         server-contract  |  env-daemon-contract
          (domain, zod,   |   (domain, zod, hono)
           hono)          |
              |           |
         core-ui          |
      (domain, zod)       |
        /       \         |
    apps/app  apps/cli    |
                     provider-adapters
                      (domain)
```

## What `apps/app` and `apps/cli` Import from `@bb/core` Today

These imports need to be redirected to `@bb/domain` or `@bb/core-ui`:

**→ `@bb/domain` (pure types):**
`Thread`, `ThreadStatus`, `ThreadType`, `ThreadWorkStatus`, `ThreadQueuedMessage`, `ThreadEventRow`, `EnvironmentRecord`, `EnvironmentCapabilities`, `Project`, `AvailableModel`, `ReasoningLevel`, `SandboxMode`, `ServiceTier`, `PromptInput`, `SystemProviderInfo`, `SystemEnvironmentInfo`, `SystemHealthReport`, `SystemStatus`, `SystemRestartPolicy`, `SystemRestartAcceptedResponse`, `SystemRestartRequest`, `SystemShutdownAcceptedResponse`, `SystemShutdownRequest`, `SystemShutdownBlockingThread`, `SystemShutdownBlockedResponse`, `ProjectFileSuggestion`, `ThreadExecutionOptions`, `EnvironmentOperationResponse`, `ThreadTimelineResponse`, `ThreadToolGroupMessagesResponse`, `ThreadGitDiffResponse`, `ThreadGitDiffSelection`, `UploadedPromptAttachment`, `OpenPathTarget`, `PrimaryCheckoutStatus`, `CommitOperationOptions`, `SquashMergeOperationOptions`, `CommitEnvironmentOperationResponse`, `SquashMergeEnvironmentOperationResponse`, `EnvironmentOperationFailureDetails`, `OpenThreadPathRequest`, `SendQueuedThreadMessageRequest`, `SendQueuedThreadMessageResponse`, `EnqueueThreadMessageRequest`, `TellThreadRequest`, `SpawnThreadRequest`, `UpdateProjectRequest`, `CreateProjectRequest`, `UpdateThreadRequest`, `ServerRuntimeMode`, `PromptMentionSuggestion`, `OpenPathEditor`, `ThreadEvent`, `ThreadEventType`, `RealtimeEntity`, `ServerMessage`, `ClientMessage`, `ChangedMessage`, `ThreadChangeKind`, `assertNever`, `ProviderToolCallRequest`, `ProviderToolCallResponse`

**→ `@bb/core-ui` (view utilities):**
`UIMessage`, `UIUserMessage`, `UIAssistantTextMessage`, `UIAssistantReasoningMessage`, `UIToolCallMessage`, `UIToolExploringMessage`, `UIWebSearchMessage`, `UIFileEditMessage`, `UIErrorMessage`, `UIDebugRawEventMessage`, `UIOperationMessage`, `UIProvisioningMetadata`, `UIProvisioningTranscriptEntry`, `ThreadDetailRow`, `ThreadDetailMessageRow`, `ThreadDetailToolGroupRow`, `toUIMessages`, `buildThreadDetailRows`, `formatTimelineAsText`, `TimelineFormat`, `extractThreadContextWindowUsage`, `ThreadContextWindowUsage`, `formatEnvironmentDisplay`, `EnvironmentDisplayInfo`, `formatEnvironmentDisplayName`, `buildCommitFailureFollowUpInstruction`, `buildSquashMergeCommitFailureFollowUpInstruction`, `buildSquashMergeConflictFollowUpInstruction`, `deriveThreadTitleFromInput`, `outputFromThreadEvent`, `extractErrorMessage`, `toRecord`, `isRecord`, `promptInputSchema`
