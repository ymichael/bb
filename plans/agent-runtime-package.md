# `@bb/agent-runtime`

This is a **package spec**, not an implementation plan. It defines the public API, internal adapter interface, and migration mapping. Implementation steps and sequencing will be planned separately when this package is built.

## Purpose

Manages agent provider processes (codex, claude-code, pi) and exposes a clean session interface. Handles process spawning, stdio framing, JSON-RPC dispatch, event translation, tool call routing, crash detection, and shutdown. Consumers say "start a thread, run a turn, give me events" — they never touch processes, adapters, or wire formats.

Replaces `packages/provider-adapters` (absorbed) and the provider management code in `packages/environment-daemon/src/runtime.ts` (absorbed).

## Dependencies

- `@bb/domain` — shared types (`ThreadEvent`, `PromptInput`, `ToolCallRequest`, etc.)
- `@bb/templates` — markdown templates (used by provider adapters for base instructions)

No other workspace dependencies. No `hono`. (Transitively depends on `zod` through `@bb/domain`.)

External dependencies (carried over from `provider-adapters`):
- `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk` — Claude Code adapter + bridge
- `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent` — Pi adapter + bridge

## Public API

```typescript
// --- Discovery ---

interface ProviderInfo {
  id: string;  // provider ID is an open string, not a closed union
  displayName: string;
  capabilities: ProviderCapabilities;
  available: boolean;
}

/** What providers are available on this machine? Checks the static
 *  adapter registry — does not require a runtime instance. */
function listAvailableProviders(): ProviderInfo[];

/** Which provider should we use by default? */
function resolveDefaultProviderId(): string;

// --- Runtime ---

interface AgentRuntimeOptions {
  /** Working directory for provider processes */
  workspacePath: string;
  /** Environment variables passed to ALL provider processes (BB_SERVER_URL, PATH, etc.) */
  env?: Record<string, string>;
  /** Called when a provider emits a translated event */
  onEvent: (event: ThreadEvent) => void;
  /** Called when a provider needs to execute a tool */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  /** Called on provider stderr lines (for logging/debugging) */
  onStderr?: (line: string, threadId?: string) => void;
  /** Called when a provider process exits unexpectedly */
  onProcessExit?: (info: {
    providerId: string;
    threadIds: string[];
    code: number | null;
    signal: string | null;
  }) => void;
}

function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime;

interface AgentRuntime {
  /**
   * Ensure a provider process is running.
   * Idempotent — won't spawn a duplicate for the same provider.
   *
   * If a provider requires per-thread process isolation (e.g., Pi),
   * the runtime spawns separate processes per thread automatically
   * based on the adapter's capabilities. The caller doesn't need
   * to know about this — just pass forThreadId.
   */
  ensureProvider(args: {
    providerId: string;
    forThreadId?: string;
  }): Promise<void>;

  /**
   * Start a new thread. Returns the provider-assigned thread ID.
   *
   * The runtime uses projectId to set env vars (BB_PROJECT_ID, BB_THREAD_ID)
   * that providers use for workspace context. The runtime does NOT look up
   * project metadata — the caller provides all context via args and
   * AgentRuntimeOptions.env.
   */
  startThread(args: {
    threadId: string;
    projectId: string;
    providerId?: string;
    input?: PromptInput[];
    options?: ThreadExecutionOptions;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId: string }>;

  /**
   * Resume an existing provider thread.
   * Returns providerThreadId if the provider reports one in its response.
   * May return undefined for providers that don't echo the thread ID on resume.
   */
  resumeThread(args: {
    threadId: string;
    providerThreadId?: string;
    providerId?: string;
    options?: ThreadExecutionOptions;
    resumePath?: string;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId?: string }>;

  /**
   * Send user input and start a turn.
   * The runtime maintains the threadId → providerThreadId mapping
   * internally (learned from startThread/resumeThread).
   */
  runTurn(args: {
    threadId: string;
    input: PromptInput[];
    options?: ThreadExecutionOptions;
  }): Promise<void>;

  /**
   * Steer an active turn with additional input.
   */
  steerTurn(args: {
    threadId: string;
    expectedTurnId: string;
    input: PromptInput[];
  }): Promise<void>;

  /**
   * Stop an active thread.
   */
  stopThread(args: { threadId: string }): Promise<void>;

  /**
   * Rename a thread.
   */
  renameThread(args: {
    threadId: string;
    title: string;
  }): Promise<void>;

  /**
   * List models available from a provider.
   */
  listModels(args: { providerId: string }): Promise<AvailableModel[]>;

  /**
   * Shut down all provider processes.
   */
  shutdown(): Promise<void>;
}
```

### Runtime state

The runtime is stateful — it maintains:
- `threadId → providerThreadId` mapping (learned from startThread/resumeThread responses)
- `threadId → childProcess` mapping (which process handles which thread)
- `providerId → childProcess` mapping (which provider is running)

If the runtime's process crashes, these mappings are lost. The caller (env-daemon) is responsible for persisting providerThreadIds and re-establishing mappings via `resumeThread` after a restart.

## Types

All from `@bb/domain`:

- `ThreadEvent` — the canonical event type. This is what `onEvent` receives.
- `PromptInput` — user input (text, image, file mention)
- `ThreadExecutionOptions` — model, service tier, reasoning level, sandbox mode. Same type used everywhere — no aliases, no renames.
- `DynamicTool` — dynamically registered tool definition
- `AvailableModel` — model metadata
- `ProviderCapabilities` — what the provider supports (supportsRename, supportsServiceTier, etc.)
- `ToolCallRequest` — `{ requestId, threadId, turnId, callId, tool, arguments? }`
- `ToolCallResponse` — `{ contentItems: Array<{ type: "inputText", text } | { type: "inputImage", imageUrl }>, success }`
- `ReasoningLevel`, `SandboxMode`, `ServiceTier` — properly typed enums, not strings

## Internal: Provider Adapter Interface

The `ProviderAdapter` interface is internal — not exported. It's the extension point for adding new providers. Each adapter translates between the runtime's commands and the provider's wire format.

```typescript
interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** The command and args to spawn this provider's process */
  process: { command: string; args: string[] };

  /** Translate a runtime command into the provider's JSON-RPC wire format.
   *  Returns null if the provider doesn't support this command
   *  (e.g., rename on a provider without supportsRename). The runtime
   *  silently skips null — it is not an error. */
  buildCommand(command: AdapterCommand): JsonRpcMessage | null;

  /** Translate a raw provider event into canonical ThreadEvents */
  translateEvent(event: unknown): ThreadEvent[];

  /** Decode a provider's tool call request into a canonical ToolCallRequest */
  decodeToolCallRequest(request: JsonRpcMessage): ToolCallRequest | null;

  /** List available models */
  listModels(): Promise<AvailableModel[]>;
}



/** A JSON-RPC 2.0 message */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;  // present for requests, absent for notifications
  method: string;
  params?: unknown;
}
```

### Tool call response flow

When a provider requests a tool call, the runtime:
1. Receives a JSON-RPC request from the provider (`{ jsonrpc: "2.0", id: 42, method: "item/tool/call", params: {...} }`)
2. Calls `adapter.decodeToolCallRequest(message)` to get a `ToolCallRequest`
3. Calls `options.onToolCall(request)` to get a `ToolCallResponse`
4. Sends `{ jsonrpc: "2.0", id: 42, result: { contentItems: [...], success: true } }` back to the provider

The response format is standard JSON-RPC 2.0 — the `id` is echoed back, `result` contains the tool response. No adapter method needed for encoding because all providers accept the same `{ contentItems, success }` shape as a JSON-RPC result.

If a provider ever needs a different response format, add an `encodeToolCallResponse` method to `ProviderAdapter` at that time. Don't add it preemptively.

### `AdapterCommand` — what the runtime asks the adapter to build

Replaces the old `ProviderRequest`. Stripped of caller-layer types (`SpawnThreadRequest`, `ProviderThreadContext`). The runtime decomposes caller args into the flat fields the adapter actually needs.

Uses domain enum types (`ReasoningLevel`, `SandboxMode`, `ServiceTier`) — not degraded to plain strings.

```typescript
type AdapterCommand =
  | { type: "initialize" }
  | { type: "thread/start"; threadId: string; input?: PromptInput[];
      options?: AdapterOptions; dynamicTools?: DynamicTool[] }
  | { type: "thread/resume"; threadId: string; providerThreadId?: string;
      options?: AdapterOptions; resumePath?: string; dynamicTools?: DynamicTool[] }
  | { type: "turn/start"; threadId: string; providerThreadId?: string;
      input: PromptInput[]; options?: AdapterOptions }
  | { type: "turn/steer"; threadId: string; providerThreadId?: string;
      expectedTurnId: string; input: PromptInput[] }
  | { type: "thread/stop"; threadId: string }
  | { type: "thread/name/set"; threadId: string; providerThreadId?: string;
      title: string };

/** Subset of ThreadExecutionOptions relevant to adapters. */
interface AdapterOptions {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  instructions?: string;
  envVars?: Record<string, string>;
}
```

### How the runtime decomposes public API calls into AdapterCommands

```
startThread({ threadId, projectId, input, options, dynamicTools })
  → runtime sets up env vars: BB_PROJECT_ID=projectId, BB_THREAD_ID=threadId
  → adapter.buildCommand({
      type: "thread/start",
      threadId,
      input,
      options: {
        model: options.model,
        sandboxMode: options.sandboxMode,
        instructions: "...",
        envVars: { BB_PROJECT_ID: projectId, BB_THREAD_ID: threadId },
      },
      dynamicTools,
    })

resumeThread({ threadId, providerThreadId, options, resumePath, dynamicTools })
  → adapter.buildCommand({
      type: "thread/resume",
      threadId,
      providerThreadId,
      options: { ... },
      resumePath,
      dynamicTools,
    })

steerTurn({ threadId, expectedTurnId, input })
  → adapter.buildCommand({
      type: "turn/steer",
      threadId,
      providerThreadId: runtime.lookupProviderThreadId(threadId),
      expectedTurnId,
      input,
    })
```

### Changes from current `ProviderAdapter`

| Current | New | Reason |
|---------|-----|--------|
| `ProviderRequest` with `SpawnThreadRequest`, `ProviderThreadContext` | `AdapterCommand` with flat fields | Adapter shouldn't know caller-layer types. Runtime decomposes. |
| `process: { command, args }` + `resolveLaunchConfiguration(context)` | `process: { command, args }` | Static property stays. `resolveLaunchConfiguration` deleted — auth is the caller's responsibility via env vars. |
| `preflightSessionStart()` | Deleted | Never called in production. Auth errors should surface at thread start. |
| `encodeToolCallResponse()` | Deleted | All providers accept `{ contentItems, success }` as JSON-RPC result. Add back if a provider ever needs custom encoding. |
| `TProviderEvent`, `TProviderCommand` generics | None | Wire types are internal to each adapter file. `translateEvent` takes `unknown`, `buildCommand` returns `JsonRpcMessage`. |
| `buildCommand` returns `TProviderCommand` | Returns `JsonRpcMessage \| null` | JSON-RPC 2.0 — all providers use this format. |
| `decodeToolCallRequest({ requestId, method, params })` | `decodeToolCallRequest(JsonRpcMessage)` | Takes raw JSON-RPC message instead of pre-parsed fields. Runtime no longer strips `id` before calling adapter. |
| No `thread/stop` command | `AdapterCommand` has `thread/stop` | New — current code stops threads by killing the process. Gives providers a chance to clean up gracefully. |
| `thread/resume` has no `dynamicTools` | `thread/resume` gains `dynamicTools` | New — current `ProviderRequest` already has `resumePath` on `thread/resume`, but `dynamicTools` was only on `thread/start`. |
| `process` + `resolveLaunchConfiguration` coexist | `process` only | `resolveLaunchConfiguration` deleted. Auth is caller's responsibility. |
| `EnvironmentDaemonProviderSpec.launchCommand/launchArgs` | Dropped | Launch wrappers not supported. Docker is an env-daemon concern, not a provider concern. |
| Per-thread process isolation (Pi workaround) | Dropped | Was a workaround in daemon runtime, not an adapter concern. Handle inside Pi adapter if still needed. |

### What else stays internal

- **Adapter implementations** — `codex-provider-adapter.ts`, `claude-code-provider-adapter.ts`, `pi-provider-adapter.ts`
- **Bridge processes** — `bridges/claude-code/` and `bridges/pi/` are separate Node.js executables spawned as child processes. Each bridge contains a process entry point (`bridge.ts`), SDK session management (`sdk-session.ts`), and tool call forwarding (`tool-proxy-mcp.ts` / `tool-proxy.ts`). Codex doesn't use a bridge — it spawns `codex app-server` directly. Bridge processes stay as-is, moved into agent-runtime alongside their parent adapters.
- **Generated Codex protocol types** — `generated/` directory containing TypeScript types for the Codex wire protocol (event/command schemas). Referenced by `codex-provider-adapter.ts`.
- **Shared bridge utilities** — `bridges/shared/bridge-tool-calls.ts` (JSON-RPC tool call forwarding protocol)
- **Process management** — spawning, stdio buffering, JSON-RPC framing, timeouts, crash detection
- **Thread-to-process routing** — mapping thread IDs to child processes, provider thread ID extraction
- **Provider initialization** — the `initialize` handshake with the provider process
- **Codex auth** — `codex-auth.ts` reads `~/.codex/auth.json`. Auth is the caller's responsibility via env vars for the runtime API, but internally the Codex adapter still needs this to resolve its launch configuration.
- **Codex model discovery** — `codex-models.ts` spawns a `codex app-server` process and sends JSON-RPC requests to discover available models. Used by `listModels()`.
- **Tool arg schemas** — `tool-arg-schemas.ts` has Zod schemas for common tool arguments (bash, file edit, web search). Used by the tool call codec.
- **Parse utilities** — `parse-utils.ts` (`asRecord`, `asNonEmptyString`) for loose JSON-RPC response parsing.

## Lifecycle

```
createAgentRuntime(options)
  │
  ├── ensureProvider({ providerId: "codex" })
  │     ├── adapter.process → { command, args }
  │     ├── spawns child process, registers exit handler
  │     └── adapter.buildCommand({ type: "initialize" }) → JSON-RPC → child
  │
  ├── startThread({ threadId, projectId, input, options })
  │     ├── ensures provider running
  │     ├── runtime decomposes args into AdapterCommand
  │     ├── adapter.buildCommand(command) → JSON-RPC
  │     ├── sends to child stdin, waits for response
  │     ├── extracts providerThreadId from result
  │     ├── stores threadId → providerThreadId mapping
  │     └── returns { providerThreadId }
  │
  ├── runTurn({ threadId, input })
  │     ├── looks up providerThreadId from internal mapping
  │     ├── adapter.buildCommand({ type: "turn/start", ... }) → JSON-RPC
  │     └── sends to child, provider starts streaming events
  │
  ├── steerTurn({ threadId, expectedTurnId, input })
  │     ├── looks up providerThreadId
  │     ├── adapter.buildCommand({ type: "turn/steer", ... }) → JSON-RPC
  │     └── sends to child
  │
  ├── [provider emits events via stdout]
  │     ├── runtime parses JSON lines
  │     ├── adapter.translateEvent(raw) → ThreadEvent[]
  │     └── calls options.onEvent(event) for each
  │
  ├── [provider requests tool call via JSON-RPC]
  │     ├── adapter.decodeToolCallRequest({ jsonrpc, id, method, params })
  │     ├── calls options.onToolCall(request)
  │     └── sends { jsonrpc: "2.0", id, result: toolCallResponse } back
  │
  ├── [provider process exits unexpectedly]
  │     └── calls options.onProcessExit({ providerId, threadIds, code, signal })
  │
  ├── stopThread({ threadId })
  │
  └── shutdown()
        └── SIGTERM all children, wait, SIGKILL if needed
```

## Testing

### CI testing (no real provider binaries)

Use a fake provider process — a small script that speaks JSON-RPC over stdio. The runtime needs a way to inject test adapters. Two options:

1. **Factory override:** `createAgentRuntime` accepts an optional `adapterFactory` that overrides the default registry:
   ```typescript
   const runtime = createAgentRuntime({
     workspacePath: tmpDir,
     onEvent: (event) => events.push(event),
     onToolCall: async (req) => ({ contentItems: [{ type: "inputText", text: "done" }], success: true }),
     // Test-only: inject a fake adapter
     adapterFactory: (providerId) => createFakeAdapter(providerId, fakeScript),
   });
   ```

2. **`registerAdapter()` method:** Add a method on the runtime for test registration. But this is less clean — prefer the factory approach.

### Real provider integration tests

Run with real codex/claude-code binaries. Gated behind `BB_E2E_PROVIDER_MODE=real`. Not part of default CI.

### Migrated tests from `provider-adapters`

The following tests migrate into agent-runtime alongside their source code:

| Test | Covers |
|------|--------|
| `codex-provider-adapter.test.ts` | Event translation, command building for Codex |
| `claude-code-provider-adapter.test.ts` | Event translation for Claude Code (reads JSON fixtures) |
| `pi-provider-adapter.test.ts` | Event translation for Pi (reads JSON fixtures) |
| `provider-registry.test.ts` | `listAvailableProviders`, `resolveDefaultProviderId` |
| `codex-auth.test.ts` | Codex auth file parsing (real filesystem, tmpdir) |
| `__fixtures__/claude-code/*.json` | 8 SDK message fixtures for Claude Code adapter tests |
| `__fixtures__/pi/*.json` | 5 SDK event fixtures for Pi adapter tests |
| `integration/provider-contract.integration.test.ts` | Full provider contract (needs real binaries) |
| `integration/provider-bridge-harness.ts` | Test utility for integration tests |

**Deleted** (LLM completion services are removed entirely):

| Test | Why |
|------|-----|
| `llm-completion.test.ts` | Tests deleted `LlmCompletionService` |
| `openai-responses-model.test.ts` | Tests deleted `generateOpenAIResponsesText` |
| `codex-title-generator.test.ts` | Tests deleted title generation |
| `codex-commit-message-generator.test.ts` | Tests deleted commit message generation |

**Deleted** (tool host is dropped — callers implement tool dispatch via `onToolCall`):

| Test | Why |
|------|-----|
| `provider-tool-host.test.ts` | `ProviderToolHost` is deleted, not moved |

## Migration from `packages/provider-adapters`

| Current | New |
|---------|-----|
| `createProviderAdapter()` | Internal — adapters are implementation details |
| `ProviderAdapter<TEvent, TCommand>` | Internal — not exported |
| `ProviderRequest` | Internal `AdapterCommand` — not exported |
| `listAvailableProviderInfos()` | `listAvailableProviders()` (returns `ProviderInfo[]`, not `SystemProviderInfo[]`) |
| `resolveDefaultProviderId()` | `resolveDefaultProviderId()` (same — default `"codex"` is a string literal internal to agent-runtime) |
| `LlmCompletionService` / `createCodexLlmCompletionService` | Deleted entirely |
| `codex-title-generator.ts` | Deleted entirely |
| `codex-commit-message-generator.ts` | Deleted entirely |
| `openai-responses-model.ts` | Deleted entirely |
| `llm-completion.ts` | Deleted entirely |
| `ProviderToolHost` | Deleted — callers implement tool dispatch via `onToolCall` callback |
| `provider-tool-call-contract.ts` | Stays, internal to agent-runtime |
| `codex-provider-adapter.ts` | Stays, internal to agent-runtime |
| `claude-code-provider-adapter.ts` | Stays, internal to agent-runtime |
| `pi-provider-adapter.ts` | Stays, internal to agent-runtime |
| `bridges/claude-code/` | Stays as-is, internal to agent-runtime |
| `bridges/pi/` | Stays as-is, internal to agent-runtime |
| `bridges/shared/` | Stays as-is, internal to agent-runtime |
| `generated/` (Codex protocol types) | Stays as-is, internal to agent-runtime |
| `codex-auth.ts` | Stays, internal to agent-runtime (Codex adapter uses it for launch config) |
| `codex-models.ts` | Stays, internal to agent-runtime (used by `listModels()`) |
| `tool-arg-schemas.ts` | Stays, internal to agent-runtime |
| `parse-utils.ts` | Stays, internal to agent-runtime |

**Note on `SpawnThreadRequest`:** Provider adapters currently import `SpawnThreadRequest` from `@bb/core`. In the new architecture, adapters use `AdapterCommand` which has flat fields — no `SpawnThreadRequest`. The runtime decomposes the caller's args. Adapters never import from `server-contract`.

**Note on `SystemProviderInfo` vs `ProviderInfo`:** The current `listAvailableProviderInfos()` returns `SystemProviderInfo` (from server-contract). The new `listAvailableProviders()` returns `ProviderInfo` (defined in agent-runtime, adds `available: boolean`). The server maps `ProviderInfo` → `SystemProviderInfo` at the API boundary — agent-runtime does not depend on server-contract.

**Note on `DEFAULT_THREAD_PROVIDER_ID`:** Was a constant in `@bb/core`. In agent-runtime, the default provider ID (`"codex"`) is a string literal in `resolveDefaultProviderId()`. No shared constant needed — it's only used in one place.

## Migration from `packages/environment-daemon/src/runtime.ts`

The following code from `runtime.ts` moves INTO `@bb/agent-runtime`:

- Process spawning (`spawnProvider`, `ensureProviderRunning`)
- JSON-RPC dispatch (`requestProvider`, `requestProviderCommand`, `tryHandleProviderRpcMessage`)
- Stdout line parsing and event translation (`toProviderEvent`)
- Tool call handling (`handleProviderServerRequest`)
- Thread-to-process mapping (`threadIdToChild`, `childToProviderId`)
- Provider initialization (`buildInitializeRequest`, `providerInitializedPids`)
- Shutdown and crash detection (`stopProviderChild`, `stopSingleChild`, exit handlers)

What stays in env-daemon (NOT absorbed):
- Session protocol (open, heartbeat, events, commands) — moves to `server-contract`
- Session sync and supervisor
- Environment channel management
- File logging
