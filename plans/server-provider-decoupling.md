# Server ↔ Provider Adapter Decoupling

## Status: Mostly complete

Done:
- ProviderSessionController takes ProviderInfo instead of ProviderAdapter
- handleNotification reads env-daemon event envelope directly
- Orchestrator caches ProviderInfo, not adapters
- deriveThreadTitleFromInput and outputFromThreadEvent in @bb/core
- Types canonical in @bb/core, no re-exports
- Scrapped @bb/provider-contracts — types live in @bb/core

## Remaining TODOs

### 1. Remove `preflightSessionStart` and Docker environment

`preflightSessionStart` exists in all three adapters but is never called in production. Delete it along with Docker environment support — Docker introduced auth-copying complexity (copying auth files into the container) that isn't justified.

Instead, provider auth errors should surface promptly when creating/following up on threads. Providers must not hang when auth is unavailable — they should fail fast with a clear error.

**Steps:**
- Delete `preflightSessionStart` from the `ProviderAdapter` interface and all implementations
- Remove Docker environment code and references
- Audit provider startup paths to ensure auth failures surface immediately (not silent hangs)

### 2. Remove server runtime imports from `@bb/provider-adapters`

The server still imports from `@bb/provider-adapters` in 5 source files. Goal: the server never touches provider adapters directly — everything goes through the env-daemon or separate packages.

**Current imports in server source (not tests):**

| Import | Used in | Purpose | Resolution |
|--------|---------|---------|------------|
| `createProviderAdapter` | `server.ts`, `orchestrator.ts` (4 sites) | Provider info lookup, listModels fallback | Move `listAvailableProviderInfos`/`resolveDefaultProviderId` to init-time lookup; listModels gets a simple error fallback |
| `listAvailableProviderInfos` | `server.ts` | Server init — enumerate available providers | Keep at init time, remove runtime usage |
| `resolveDefaultProviderId` | `server.ts` | Server init — pick default provider | Keep at init time |
| `ProviderToolHost` | `server.ts`, `orchestrator.ts`, `provider-session-controller.ts`, `manager-tools.ts` | MCP/dynamic tool execution on server side | Move to own package or into server (it's server-side tool execution, not provider translation) |
| `LlmCompletionService` / `createCodexLlmCompletionService` | `server.ts`, `orchestrator.ts` | Title/commit message generation | Replace with `@anthropic-ai/sdk` via pi-mono's `@pi/ai` package |

**Steps:**
1. Replace `LlmCompletionService` with `@pi/ai` (uses Anthropic SDK directly instead of rolling our own LLM call code)
2. Move `ProviderToolHost` into the server package (it's server-side tool execution)
3. Remove `createProviderAdapter` from orchestrator — `listModels` gets a simple error fallback when env-daemon is unavailable
4. Keep `listAvailableProviderInfos`/`resolveDefaultProviderId` at server init only (one-time, not runtime)

### 3. Fix `ServerDeps.provider` typed as `any`

Deferred until contract boundaries are clear. Currently `any` is used for e2e test provider injection. Will be resolved as part of the boundary contract work (see `protocol-boundary-contracts.md` plan).

## Closed TODOs

- ~~`supportsSteer` in `ProviderCapabilities`~~ — All providers support steer. No capability flag needed.
