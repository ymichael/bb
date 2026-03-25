# @bb/agent-runtime

Manages agent provider processes (codex, claude-code, pi) and exposes a clean session interface. Handles process spawning, stdio framing, JSON-RPC dispatch, event translation, tool call routing, crash detection, and shutdown.

Consumers say "start a thread, run a turn, give me events" — they never touch processes, adapters, or wire formats.

## Public API

```typescript
import { createAgentRuntime, listAvailableProviders, resolveDefaultProviderId } from "@bb/agent-runtime";

// Discovery
const providers = listAvailableProviders();   // [{ id: "codex", ... }, { id: "claude-code", ... }, { id: "pi", ... }]
const defaultId = resolveDefaultProviderId(); // "codex" (or BB_DEFAULT_PROVIDER env var)

// Runtime — supports multiple providers and threads simultaneously
const runtime = createAgentRuntime({
  workspacePath: "/path/to/workspace",
  env: { OPENAI_API_KEY: "..." },       // passed to all provider processes
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
  threadId: "t1",
  projectId: "p1",
  providerId: "codex",
  options: { sandboxMode: "danger-full-access", instructions: "Be concise." },
  dynamicTools: [{ name: "my_tool", description: "...", inputSchema: { ... } }],
});

await runtime.runTurn({
  threadId: "t1",
  input: [{ type: "text", text: "Hello" }],
});

// Multiple threads on the same runtime, even across providers
await runtime.startThread({ threadId: "t2", projectId: "p1", providerId: "claude-code" });

// Resume across process lifetimes
await runtime.resumeThread({
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

## Package Structure

```
src/
├── index.ts                  Public exports
├── types.ts                  AgentRuntime, AgentRuntimeOptions, ProviderInfo
├── runtime.ts                createAgentRuntime implementation
├── provider-adapter.ts       ProviderAdapter interface, AdapterCommand, JsonRpcMessage
├── provider-registry.ts      Built-in adapter registry
├── codex/
│   ├── adapter.ts            Codex adapter (event translation, command building)
│   ├── adapter.test.ts       Codex adapter unit tests
│   ├── models.ts             Codex model discovery
│   └── generated/            Codex JSON-RPC protocol types
├── claude-code/
│   ├── adapter.ts            Claude Code adapter
│   ├── adapter.test.ts       Claude Code adapter unit tests
│   └── bridge/               Bridge process (spawned as child)
│       ├── bridge.ts         JSON-RPC entry point
│       ├── sdk-session.ts    Claude Agent SDK session management
│       └── tool-proxy-mcp.ts MCP server for tool call forwarding
├── pi/
│   ├── adapter.ts            Pi adapter
│   ├── adapter.test.ts       Pi adapter unit tests
│   └── bridge/               Bridge process (spawned as child)
│       ├── bridge.ts         JSON-RPC entry point
│       ├── sdk-session.ts    Pi SDK session management
│       └── tool-proxy.ts     Tool call forwarding
├── shared/
│   ├── adapter-utils.ts      Shared adapter utilities (base instructions, tool translation, etc.)
│   ├── bridge-tool-calls.ts  Shared JSON-RPC tool call utilities
│   ├── provider-tool-call-contract.ts  Tool call request/response codec
│   ├── tool-arg-schemas.ts   Zod schemas for tool arguments
│   └── parse-utils.ts        JSON parsing helpers
├── __fixtures__/             Shared test fixtures (SDK message samples)
├── runtime.test.ts           Runtime unit tests (110 tests, fake provider process)
├── provider-registry.test.ts Registry unit tests
└── integration.test.ts       Integration tests (27 tests, real providers)
```

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

| Provider | Credentials |
|----------|-------------|
| codex | `OPENAI_API_KEY` env var or `~/.codex/auth.json` (run `codex login`) |
| claude-code | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` env var |
| pi | `~/.pi/agent/auth.json` (run `pi login`) |

Credentials can be set in the repo root `.env` file — the integration test config loads it automatically.

### Working with integration tests

Integration tests hit real provider APIs and take 30-60 seconds. Some lessons learned:

**Don't assume provider behavior — test it directly.** Each provider (codex, claude-code, pi) has different concurrency, turn lifecycle, and session resume semantics. When a test fails or hangs, write a small standalone test that probes the provider directly (e.g., "does codex handle two concurrent turns on different threads?") instead of guessing and tweaking timeouts. The `vitest.config.ts` unit test config is handy for running quick one-off investigations since it includes `src/**/*.test.ts`.

**Save output to a file, then read it.** Tests are slow — if you pipe output through `grep` and it doesn't match, you've wasted a full test run. Instead:
```bash
pnpm --filter @bb/agent-runtime test:integration -- --reporter=verbose > /tmp/integ-out.txt 2>&1
# Then inspect:
grep -E "(✓|×|Test Files|Tests )" /tmp/integ-out.txt
```

**Credentials live in `.env` at the repo root.** The integration vitest config loads this file automatically. Check what's available:
```bash
grep -E "OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY" .env | sed 's/=.*/=<set>/'
```
For pi, check `~/.pi/agent/auth.json` exists. For codex, `~/.codex/auth.json` or `OPENAI_API_KEY`.

**Build before running integration tests.** Bridge processes (claude-code, pi) run from `dist/`, not `src/`. If you change bridge or adapter code, rebuild first:
```bash
pnpm exec turbo run build --filter=@bb/agent-runtime --force
```

**Tests run concurrently across providers.** All 3 provider suites run in parallel via `describe.concurrent`. This means the total wall time is roughly the slowest provider, not the sum. Cross-provider tests also run concurrently with each other.

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

```bash
pnpm exec turbo run build --filter=@bb/agent-runtime
```

Integration tests require a build first (bridge processes run from `dist/`).

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
- `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk` — Claude Code
- `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent` — Pi
- `zod` — schema validation at provider boundaries
