# @bb/agent-runtime

Manages agent provider processes (codex, claude-code, pi) and exposes a clean session interface. Handles process spawning, stdio framing, JSON-RPC dispatch, event translation, tool call routing, crash detection, and shutdown.

Consumers say "start a thread, run a turn, give me events" — they never touch processes, adapters, or wire formats.

## Public API

```typescript
import { createAgentRuntime, listAvailableProviders } from "@bb/agent-runtime";

// Discovery
const providers = listAvailableProviders();   // [{ id: "codex", ... }, { id: "claude-code", ... }, { id: "pi", ... }]

// Runtime — supports multiple providers and threads simultaneously
const runtime = createAgentRuntime({
  workspacePath: "/path/to/workspace",
  env: { OPENAI_API_KEY: "..." },       // passed to all provider processes
  bridgeBundleDir: "/path/to/bundled-bridges", // optional; used when bridges are packaged outside src/dist
  onEvent: (event) => {
    // Every event has event.threadId (bb ID) and event.providerThreadId (provider's internal ID)
    // See ProviderThreadEvent in @bb/domain for the full type
  },
  onToolCall: async (req) => { /* ToolCallRequest → ToolCallResponse */ },
  onStderr: (line) => { /* provider stderr */ },
  onProcessExit: (info) => { /* crash detection */ },
});

// Start a thread, run turns, get events via callbacks
const { providerThreadId } = await runtime.startThread({
  environmentId: "env-1",
  threadId: "t1",
  projectId: "p1",
  providerId: "codex",
  options: { permissionMode: "full", instructions: "Be concise." },
  dynamicTools: [{ name: "my_tool", description: "...", inputSchema: { ... } }],
});

await runtime.runTurn({
  threadId: "t1",
  input: [{ type: "text", text: "Hello" }],
});

// Multiple threads on the same runtime, even across providers
await runtime.startThread({
  environmentId: "env-1",
  threadId: "t2",
  projectId: "p1",
  providerId: "claude-code",
});

// Resume across process lifetimes
await runtime.resumeThread({
  environmentId: "env-1",
  threadId: "t3",
  providerThreadId, // from previous session
  providerId: "codex",
});

await runtime.shutdown();
```

### Event types

Events from provider processes are `ProviderThreadEvent` — they carry both `threadId` (bb ID) and `providerThreadId` (provider's internal ID). Events from the server/system layer are `SystemThreadEvent` — they only have `threadId`. Both are part of the `ThreadEvent` union from `@bb/domain`.

### Fail-fast behavior

The runtime fails fast when providers crash or are unavailable:

- **Binary not found** → `ensureProvider` rejects immediately
- **Crash during initialize** → `ensureProvider` rejects with stderr output
- **Crash during a turn** → pending `runTurn` promise rejects with "exited unexpectedly"
- **Crash between turns** → next `runTurn` call rejects immediately
- **Identity not resolved** → `startThread` throws after 5s instead of silently returning wrong data

### Multi-thread / multi-provider

A single runtime can manage multiple threads across multiple providers simultaneously. Each provider process is spawned once and shared across threads. The runtime stamps every event with the correct bb `threadId` and `providerThreadId` regardless of how the provider internally identifies threads.

## Running Tests

```bash
# Unit tests (no credentials needed, uses fake provider process)
pnpm --filter @bb/agent-runtime test:unit

# Integration tests (requires real provider credentials)
pnpm --filter @bb/agent-runtime test:integration

# All tests
pnpm --filter @bb/agent-runtime test
```

### Integration test requirements

All providers must be authenticated in the current environment before running integration tests. Each provider manages its own credentials (auth files, env vars, etc.).

### Working with integration tests

Integration tests hit real provider APIs and take 30-60 seconds. Some lessons learned:

**Don't assume provider behavior — test it directly.** Each provider (codex, claude-code, pi) has different concurrency, turn lifecycle, and session resume semantics. When a test fails or hangs, write a small standalone test that probes the provider directly (e.g., "does codex handle two concurrent turns on different threads?") instead of guessing and tweaking timeouts. The `vitest.config.ts` unit test config is handy for running quick one-off investigations since it includes `src/**/*.test.ts`.

**Save output to a file, then read it.** Tests are slow — if you pipe output through `grep` and it doesn't match, you've wasted a full test run. Instead:

```bash
pnpm --filter @bb/agent-runtime test:integration -- --reporter=verbose > /tmp/integ-out.txt 2>&1
# Then inspect:
grep -E "(✓|×|Test Files|Tests )" /tmp/integ-out.txt
```

**Tests run concurrently within each scenario file.** All 3 provider variants in a file run in parallel via `describe.concurrent`. Scenario files run serially because Pi and other real providers share local auth state and external provider limits; running every scenario file at once has caused real-provider flakes where a turn completes without the expected tool execution.

**When a test hangs**, the provider is likely not responding to a JSON-RPC request. Common causes:

- Bridge Zod schema rejects the request silently (check that `buildCommand` output matches what the bridge expects)
- Provider needs credentials that aren't in the environment
- Bridge process crashed on startup (check stderr — the runtime captures it in `proc.stderrChunks`)

### Test coverage

**Unit tests (110)** — runtime lifecycle, multi-thread event routing, multi-provider, tool call round-trips, JSON-RPC error handling, fail-fast on crashes (binary not found, crash during init, crash mid-turn, crash between turns), concurrent `ensureProvider` deduplication, resume across runtimes, adapter event translation.

**Integration tests (27)** run all 3 providers concurrently in ~45 seconds:

- **Per-provider tests** (7 × 3 = 21): lists models, single turn, follow-up turn, developer instructions, error recovery, dynamic tool calls, resume across process lifetimes
- **Cross-provider tests** (6): multi-thread on same runtime, multi-provider in single runtime, dynamic tools across resume, memory recall across resume, combined memory+tools across restart, multi-provider matrix with resume

### Building

`@bb/agent-runtime` is source-only inside this workspace. The host daemon build
creates the bridge bundles it needs for runtime startup.

## Architecture

```
Consumer (host-daemon, server)
  │
  └─ createAgentRuntime(options)
       │
       ├─ AgentRuntime            Process lifecycle, JSON-RPC framing,
       │   ├─ ensureProvider()    event routing, tool call dispatch
       │   ├─ startThread()      Deduplicates concurrent provider starts.
       │   ├─ runTurn()          Fails fast if provider has crashed.
       │   └─ shutdown()
       │
       ├─ ProviderAdapter         Command building, event translation
       │   ├─ buildCommand()      (one instance per provider process)
       │   ├─ translateEvent()    Per-thread turn state for multi-thread.
       │   └─ decodeToolCallRequest()
       │
       └─ Bridge Process          SDK-specific child process
           ├─ codex               spawns `codex app-server` directly
           ├─ claude-code         Node.js bridge → Claude Agent SDK
           └─ pi                  Node.js bridge → Pi coding agent SDK
```

The runtime never interprets provider-specific wire content. Each adapter owns its translation between the runtime's `AdapterCommand` and the provider's JSON-RPC format.

## Dependencies

- `@bb/domain` — shared types (ThreadEvent, ProviderThreadEvent, PromptInput, ToolCallRequest, etc.)
- `@bb/templates` — markdown templates for provider instructions
- `@anthropic-ai/claude-agent-sdk` — Claude Code
- `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent` — Pi
- `zod` — schema validation at provider boundaries
