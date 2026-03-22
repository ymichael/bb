# `@bb/agent-runtime`

## Purpose

Manages agent provider processes (codex, claude-code, pi) and exposes a clean session interface. Handles process spawning, stdio framing, JSON-RPC dispatch, event translation, tool call routing, and shutdown. Consumers say "start a thread, run a turn, give me events" — they never touch processes, adapters, or wire formats.

Replaces `packages/provider-adapters` (absorbed) and the provider management code in `packages/environment-daemon/src/runtime.ts` (absorbed).

## Dependencies

- `@bb/domain` — shared types (`ThreadEvent`, `PromptInput`, `ProviderToolCallRequest`, etc.)

No other workspace dependencies. No `zod`, no `hono`.

## Public API

```typescript
// --- Discovery ---

interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  available: boolean;
}

/** What providers are available on this machine? */
function listAvailableProviders(): ProviderInfo[];

/** Which provider should we use by default? */
function resolveDefaultProviderId(): string;

// --- Runtime ---

interface AgentRuntimeOptions {
  /** Working directory for provider processes */
  workspacePath: string;
  /** Environment variables passed to provider processes */
  env?: Record<string, string>;
  /** Called when a provider emits a translated event */
  onEvent: (event: ThreadEvent) => void;
  /** Called when a provider needs to execute a tool */
  onToolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  /** Called on provider stderr lines (for logging/debugging) */
  onStderr?: (line: string, threadId?: string) => void;
}

function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime;

interface AgentRuntime {
  /**
   * Ensure a provider process is running.
   * Idempotent — won't spawn a duplicate.
   */
  ensureProvider(args: {
    providerId: string;
    forThreadId?: string;
  }): Promise<void>;

  /**
   * Start a new thread. Returns the provider-assigned thread ID.
   */
  startThread(args: {
    threadId: string;
    projectId: string;
    providerId?: string;
    input?: PromptInput[];
    options?: ExecutionOptions;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId: string }>;

  /**
   * Resume an existing provider thread.
   */
  resumeThread(args: {
    threadId: string;
    providerThreadId?: string;
    providerId?: string;
    options?: ExecutionOptions;
    resumePath?: string;
    dynamicTools?: DynamicTool[];
  }): Promise<{ providerThreadId?: string }>;

  /**
   * Send user input and start a turn.
   */
  runTurn(args: {
    threadId: string;
    input: PromptInput[];
    options?: ExecutionOptions;
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

## Types

All from `@bb/domain`:

- `ThreadEvent` — the canonical event type. This is what `onEvent` receives. Already has `threadId`, `type`, and all event data.
- `PromptInput` — user input (text, image, file mention)
- `ExecutionOptions` — model, service tier, reasoning level, sandbox mode
- `DynamicTool` — dynamically registered tool definition
- `AvailableModel` — model metadata
- `ProviderCapabilities` — what the provider supports
- `ToolCallRequest` — tool invocation from provider (requestId, threadId, turnId, callId, tool, arguments)
- `ToolCallResponse` — tool result back to provider (contentItems, success)

## Internal: Provider Adapter Interface

The `ProviderAdapter` interface is internal — not exported. It's the extension point for adding new providers. Each adapter translates between the runtime's commands and the provider's wire format.

```typescript
interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** How to launch this provider's process */
  resolveLaunch(): Promise<ProviderLaunch>;

  /** Translate a runtime command into the provider's JSON-RPC wire format */
  buildCommand(command: AdapterCommand): JsonRpcRequest | null;

  /** Translate a raw provider event into canonical ThreadEvents */
  translateEvent(event: unknown): ThreadEvent[];

  /** Decode a provider's tool call request into a canonical ToolCallRequest */
  decodeToolCallRequest(request: JsonRpcRequest): ToolCallRequest | null;

  /** List available models */
  listModels(): Promise<AvailableModel[]>;
}

interface ProviderLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  method: string;
  params?: unknown;
}
```

### `AdapterCommand` — what the runtime asks the adapter to build

Replaces the old `ProviderRequest`. Stripped of caller-layer types (`SpawnThreadRequest`, `ProviderThreadContext`). The runtime decomposes caller args into the flat fields the adapter actually needs.

```typescript
type AdapterCommand =
  | { type: "initialize" }
  | { type: "thread/start"; threadId: string; input?: PromptInput[];
      options?: AdapterExecutionOptions; dynamicTools?: DynamicTool[] }
  | { type: "thread/resume"; threadId: string; providerThreadId?: string;
      options?: AdapterExecutionOptions }
  | { type: "turn/start"; threadId: string; providerThreadId?: string;
      input: PromptInput[]; options?: AdapterExecutionOptions }
  | { type: "turn/steer"; threadId: string; providerThreadId?: string;
      expectedTurnId: string; input: PromptInput[] }
  | { type: "thread/stop"; threadId: string }
  | { type: "thread/name/set"; threadId: string; providerThreadId?: string;
      title: string };

interface AdapterExecutionOptions {
  model?: string;
  serviceTier?: string;
  reasoningLevel?: string;
  sandboxMode?: string;
  instructions?: string;
  envVars?: Record<string, string>;
}
```

### Changes from current `ProviderAdapter`

| Current | New | Reason |
|---------|-----|--------|
| `ProviderRequest` with `SpawnThreadRequest`, `ProviderThreadContext` | `AdapterCommand` with flat fields | Adapter shouldn't know caller-layer types. Runtime decomposes. |
| `process: { command, args }` property | `resolveLaunch()` method | Launch config may need async resolution (auth files). Static property was too rigid. |
| `resolveLaunchConfiguration(context)` | `resolveLaunch()` (no args) | Adapter resolves its own launch config. Thread context is a runtime concern. |
| `preflightSessionStart()` | Deleted | Never called in production. Auth errors should surface at thread start. |
| `encodeToolCallResponse()` | Deleted | Identity in practice. If encoding is needed, handle in `decodeToolCallRequest`. |
| `TProviderEvent`, `TProviderCommand` generics | None | Wire types are internal to each adapter file. No need to leak into interface. `translateEvent` takes `unknown`, `buildCommand` returns `JsonRpcRequest`. |
| `buildCommand` returns `TProviderCommand` | Returns `JsonRpcRequest \| null` | Generic JSON-RPC — all providers use this format. |

### What else stays internal

- **Adapter implementations** — `codex-provider-adapter.ts`, `claude-code-provider-adapter.ts`, `pi-provider-adapter.ts`
- **Process management** — spawning, stdio buffering, JSON-RPC framing, timeouts, crash detection
- **Thread-to-process routing** — mapping thread IDs to child processes, provider thread ID extraction
- **Provider initialization** — the `initialize` handshake with the provider process

## Lifecycle

```
createAgentRuntime(options)
  │
  ├── ensureProvider({ providerId: "codex" })
  │     ├── adapter.resolveLaunch() → { command, args, env }
  │     ├── spawns child process
  │     └── adapter.buildCommand({ type: "initialize" }) → JSON-RPC → child
  │
  ├── startThread({ threadId, projectId, input, options })
  │     ├── ensures provider running
  │     ├── runtime decomposes args into AdapterCommand:
  │     │     { type: "thread/start", threadId, input, options: { model, sandboxMode, instructions } }
  │     ├── adapter.buildCommand(command) → JSON-RPC
  │     ├── sends to child stdin, waits for response
  │     ├── extracts providerThreadId from result
  │     └── returns { providerThreadId }
  │
  ├── runTurn({ threadId, input })
  │     ├── adapter.buildCommand({ type: "turn/start", ... }) → JSON-RPC
  │     └── sends to child, provider starts streaming events
  │
  ├── [provider emits events via stdout]
  │     ├── runtime parses JSON lines
  │     ├── adapter.translateEvent(raw) → ThreadEvent[]
  │     └── calls options.onEvent(event) for each
  │
  ├── [provider requests tool call via JSON-RPC]
  │     ├── adapter.decodeToolCallRequest({ method, params })
  │     ├── calls options.onToolCall(request)
  │     └── sends JSON-RPC response back to provider
  │
  ├── stopThread({ threadId })
  │
  └── shutdown()
        └── SIGTERM all children, wait, SIGKILL if needed
```

## Testing

Integration tests test the public API, not adapters:

```typescript
// Good: test the contract
const events: ThreadEvent[] = [];
const runtime = createAgentRuntime({
  workspacePath: tmpDir,
  onEvent: (event) => events.push(event),
  onToolCall: async (req) => ({ contentItems: [{ type: "inputText", text: "done" }], success: true }),
});
await runtime.ensureProvider({ providerId: "codex" });
const { providerThreadId } = await runtime.startThread({
  threadId: "t1",
  projectId: "p1",
  input: [{ type: "text", text: "hello" }],
});
expect(providerThreadId).toBeDefined();
// wait for events...
expect(events.some(e => e.type === "turn/started")).toBe(true);
await runtime.shutdown();
```

No custom test harness that replicates what the runtime does. The tests exercise the real code path.

## Migration from `packages/provider-adapters`

| Current | New |
|---------|-----|
| `createProviderAdapter()` | Internal — adapters are implementation details |
| `ProviderAdapter<TEvent, TCommand>` | Internal — not exported |
| `ProviderRequest` | Internal — not exported |
| `listAvailableProviderInfos()` | `listAvailableProviders()` |
| `resolveDefaultProviderId()` | `resolveDefaultProviderId()` (same) |
| `LlmCompletionService` / `createCodexLlmCompletionService` | Deleted — use `@pi/ai` directly |
| `ProviderToolHost` | Moves to server (it's server-side tool execution) |
| `codex-provider-adapter.ts` | Stays, but internal to agent-runtime |
| `claude-code-provider-adapter.ts` | Stays, but internal to agent-runtime |
| `pi-provider-adapter.ts` | Stays, but internal to agent-runtime |

## Migration from `packages/environment-daemon/src/runtime.ts`

The following code from `runtime.ts` moves INTO `@bb/agent-runtime`:

- Process spawning (`spawnProvider`, `ensureProviderRunning`)
- JSON-RPC dispatch (`requestProvider`, `requestProviderCommand`, `tryHandleProviderRpcMessage`)
- Stdout line parsing and event translation (`toProviderEvent`)
- Tool call handling (`handleProviderServerRequest`)
- Thread-to-process mapping (`threadIdToChild`, `childToProviderId`)
- Provider initialization (`buildInitializeRequest`, `providerInitializedPids`)
- Shutdown (`stopProviderChild`, `stopSingleChild`)

What stays in env-daemon (NOT absorbed):
- Session protocol (open, heartbeat, events, commands) — moves to `server-contract`
- Session sync and supervisor
- Environment channel management
- File logging
