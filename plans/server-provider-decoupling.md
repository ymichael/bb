# Server ↔ Provider Adapter Decoupling

## Goal

The server should not import `ProviderAdapter` or call adapter methods directly. Everything provider-related goes through the env-daemon protocol. The env-daemon is the single runtime owner of provider adapters.

## Current State

The server imports from `@bb/provider-adapters`:

- `createProviderAdapter`, `listAvailableProviderInfos`, `resolveDefaultProviderId` — registry functions
- `ProviderAdapter` type — held by `ProviderSessionController` and `Orchestrator`
- `ProviderToolHost` — server-side tool execution
- `LlmCompletionService` — title/commit generation (separate concern)
- `ProviderExecutionOptions`, `ProviderThreadContext`, etc. — types

The `ProviderSessionController` calls these adapter methods directly:

- `preflightSessionStart()` — auth check before starting
- `interpretNotification()` — re-interpret events from env-daemon
- `deriveThreadTitle()` — extract title from input
- `outputFromEvent()` — extract text from persisted events
- `inactiveSessionErrorMessage()` — error message template
- `buildTurnSteerCommand` existence — capability check
- `buildThreadNameSetCommand` existence — capability check
- `decodeToolCallRequest()` / `encodeToolCallResponse()` — tool call codec
- `id`, `displayName` — provider identity

## Target State

### Server imports from `@bb/provider-adapters`: types only

```ts
import type {
  BbProviderEvent,
  ProviderExecutionOptions,
  ProviderThreadContext,
  ProviderDynamicTool,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "@bb/provider-adapters";
```

Plus `ProviderToolHost` (runtime, but should eventually move to its own package).

### What moves where

| Current                                            | Target                                                                                                                      | Rationale                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deriveThreadTitle(input)`                         | `@bb/core` utility                                                                                                          | Not provider-specific — all adapters did the same thing                                              |
| `outputFromEvent(event)`                           | `@bb/core` utility                                                                                                          | Reads persisted data, not provider translation                                                       |
| `inactiveSessionErrorMessage(threadId)`            | Inline in server: `` `Thread ${threadId} has no ${displayName} session` ``                                                  | Trivially derivable                                                                                  |
| `normalizeEventType(method)`                       | Delete                                                                                                                      | Dead concept — events are now canonical `BbProviderEvent.type`                                       |
| `interpretNotification()`                          | Delete from server                                                                                                          | Env-daemon already translates events. Server reads `BbProviderEvent` fields from the event envelope. |
| `preflightSessionStart()`                          | New env-daemon command: `provider.preflight`                                                                                | Auth belongs in the env-daemon                                                                       |
| `buildTurnSteerCommand` existence                  | `capabilities.supportsSteer` on provider info, OR let env-daemon handle (it already resolves steer vs start)                | Capability check                                                                                     |
| `buildThreadNameSetCommand` existence              | `capabilities.supportsRename` on provider info                                                                              | Capability check                                                                                     |
| `decodeToolCallRequest` / `encodeToolCallResponse` | Env-daemon handles codec. Server receives already-decoded `ProviderToolCallRequest` and returns `ProviderToolCallResponse`. | The env-daemon is the codec boundary                                                                 |
| `listModels(providerId)`                           | Already an env-daemon command (`provider.list_models`)                                                                      | Just stop the fallback path that calls adapter directly                                              |
| `listAvailableProviderInfos()`                     | Already an env-daemon command (`provider.list_catalog`)                                                                     | Same                                                                                                 |
| `createProviderAdapter()`                          | Delete from server                                                                                                          | Server doesn't create adapters                                                                       |

### ProviderSessionController changes

Before:

```ts
interface ProviderSessionControllerOptions {
  provider: ProviderAdapter;
  // ...
}
```

After:

```ts
interface ProviderSessionControllerOptions {
  providerId: string;
  providerDisplayName: string;
  providerCapabilities: ProviderCapabilities;
  // ...
}
```

The controller no longer holds a `ProviderAdapter` reference. It:

- Uses `providerId` and `providerDisplayName` for logging/errors
- Uses `providerCapabilities.supportsRename` / `.supportsSteer` for guards
- Sends all commands through the env-daemon client (already does this)
- Receives events from the env-daemon that are already translated (already does this — just needs to stop re-interpreting them)

### Env-daemon protocol additions

New command:

```ts
| {
    type: "provider.preflight";
    providerId: string;
  }
```

Response: `{ ok: true }` or error with message.

### Event envelope changes

The env-daemon event envelope already carries metadata from `translateEvent`:

```ts
{
  type: "provider.event",
  threadId: string,
  method: string,          // canonical method from BbProviderEvent.type
  payload: unknown,        // raw event data for persistence
  normalizedMethod: string,
  shouldPersist: boolean,
  shouldBroadcast: boolean,
  nextStatus?: Thread["status"],
  title?: string,
  turnState?: "active" | "idle",
  turnId?: string,
  providerThreadId?: string,
}
```

The server reads these fields directly instead of re-interpreting the payload through `interpretNotification`.

### ServerDeps changes

Before:

```ts
interface ServerDeps {
  provider?: ProviderAdapter;
  // ...
}
```

After:

```ts
interface ServerDeps {
  providerId?: string;
  // ...
}
```

E2e tests that need a fake provider configure it through the env-daemon test harness, not by injecting a `ProviderAdapter` into the server.

### New package: `@bb/provider-contracts`

Contract types that define the shapes flowing between server, env-daemon, and provider-adapters. No runtime code — types only.

Lives in: `packages/provider-contracts/`

Exports:
- `BbProviderEvent` and all supporting types (`BbProviderEventItem`, `BbProviderEventTurnStatus`, `BbProviderEventItemStatus`, `BbProviderEventFileChange`, `BbProviderEventFileChangeKind`, `BbProviderEventPlanStep`, `BbProviderEventPlanStepStatus`, `BbProviderEventUserContent`, `BbProviderEventTokenUsage`, `BbProviderEventTokenUsageBreakdown`, `BbProviderEventWarningCategory`)
- `ProviderRequest`
- `ProviderExecutionOptions`, `ProviderThreadContext`
- `ProviderCapabilities` (moved from `@bb/core`)
- `ProviderToolCallRequest`, `ProviderToolCallResponse`, `ProviderToolCallOutputItem`
- `ProviderDynamicTool`
- `ProviderLaunchConfiguration`, `ProviderLaunchFile`, `ProviderLaunchFilePlacement`
- `ProviderAdapter` interface (the contract adapters implement)

Dependency graph:
```
@bb/server        →  @bb/provider-contracts (types only)
@bb/env-daemon    →  @bb/provider-contracts (types only)
                  →  @bb/provider-adapters  (runtime)
@bb/provider-adapters →  @bb/provider-contracts (types only)
```

The server never depends on `@bb/provider-adapters` at all (except for `ProviderToolHost` which will move out separately).

## Implementation Steps

1. Create `@bb/provider-contracts` package with types from `provider-adapter.ts`
2. Update `@bb/provider-adapters` to import types from `@bb/provider-contracts`
3. Move `deriveThreadTitleFromInput` and `outputFromEvent` to `@bb/core`
4. Add `supportsSteer` to `ProviderCapabilities`
5. Add `provider.preflight` command to env-daemon protocol
6. Refactor `ProviderSessionController` to take provider info instead of adapter
7. Update `ProviderSessionController.handleNotification` to read event envelope fields
8. Update `Orchestrator` to stop creating/caching adapters — get provider info from env-daemon
9. Update `ServerDeps` — `providerId` instead of `provider`
10. Update e2e test harness
11. Remove server's runtime imports from `@bb/provider-adapters`
