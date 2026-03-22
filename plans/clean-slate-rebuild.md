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
| `packages/provider-adapters` | Yes (code) | Recently rewritten. Package boundary needs work — consumers reach too deep into internals |
| `packages/templates` | Yes | Mostly markdown |
| `packages/db` | Schema only | Keep drizzle schema + migrations + connection. Delete repository layer |
| `qa/` | Consolidate | Fold into single `qa/README.md` describing all features to QA |

## What We Delete

| Package | Reason |
|---------|--------|
| `packages/core` | Replaced by `packages/domain`. Core mixes domain types, UI formatting, event rendering, Zod request schemas, runtime contracts, and helpers — too many concerns |
| `packages/environment-daemon` | Rebuilt from contract. Protocol types move to contracts, runtime rebuilt |
| `packages/environment` | Rebuilt. Provisioning strategies, git workspace management |
| `packages/api-contract` | Replaced by `packages/server-contract` |
| `packages/env-daemon-contract` | Redefined — becomes the daemon's own server contract, not the session protocol |
| `apps/server` | Rebuilt from contracts. The orchestrator, session services, event applier, command dispatcher — all of it |

## New Package Architecture

```
packages/
├── domain/                  # Pure types — zero logic, zero dependencies
├── logger/                  # Structured logging primitive
├── env/                     # Declarative env var definitions (envsafe-style)
├── server-contract/         # What the server serves (HTTP contract)
├── env-daemon-contract/     # What the env-daemon serves (HTTP contract)
├── db/                      # Drizzle schema + migrations (no repositories)
├── provider-adapters/       # Provider integration (keep, fix boundary)
├── templates/               # Markdown templates (keep)
├── ui-core/                 # Shared UI (keep)
└── tsconfig/                # Build config (keep)

apps/
├── app/                     # Frontend (keep)
├── cli/                     # CLI (keep)
└── server/                  # Rebuilt from contracts
```

### `packages/domain`

Pure domain types. No logic, no utilities, no formatting, no Zod schemas. Just TypeScript interfaces and type unions that describe the domain.

**Contains:**
- Entity types: `Project`, `Thread`, `EnvironmentRecord`
- Thread state types: `ThreadStatus`, `ThreadWorkStatus`, `ThreadProvisioningState`
- Event types: `ThreadEvent` (discriminated union), event data interfaces
- Provider types: `ThreadProviderId`, `ProviderCapabilities`
- Execution options: `ReasoningLevel`, `SandboxMode`, `ServiceTier`, `PromptInput`
- Operation types: commit, squash-merge, promote/demote
- System types: `SystemStatus`, `SystemHealthReport`, `SystemProviderInfo`

**Does NOT contain:**
- Zod schemas (those go in contract packages)
- Formatting/display logic (UI rendering moves to `ui-core` or stays in `apps/app`)
- `toUIMessages()`, `formatTimelineAsText()`, `buildThreadDetailRows()` — these are view concerns
- `unknown-helpers.ts` — eliminated by proper boundaries
- `wire-decoders.ts` — already deleted
- Runtime contracts (`ThreadOrchestrator`) — that's a server concern

**Dependencies:** None. This package has zero dependencies.

**Open question:** Where do `toUIMessages` and `formatTimelineAsText` live? Options:
- `packages/ui-core` — alongside other UI primitives
- `apps/app/src/lib/` — app-specific concern
- A new `packages/thread-ui` — if CLI also needs event rendering

### `packages/logger`

Structured logging primitive designed for debuggability from day 1.

**Goals:**
- Structured JSON log entries with consistent fields (timestamp, level, component, correlationId)
- Correlation IDs that flow across server ↔ daemon ↔ provider boundaries
- Log levels: trace, debug, info, warn, error
- Pluggable transports: console, file, rotating file
- Zero-dependency core (no winston/pino — just a thin interface over structured output)
- Child loggers with inherited context (`logger.child({ threadId, sessionId })`)

**Interface sketch:**
```typescript
interface Logger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

interface LogTransport {
  write(entry: LogEntry): void;
}

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  component?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}
```

**Dependencies:** None.

### `packages/env`

Declarative environment variable definitions with validation and defaults.

**Goals:**
- Single source of truth for all env vars used across the system
- Validation at startup — fail fast with clear error messages
- Type-safe access — no `process.env.FOO?.trim()` scattered through code
- Defaults documented in code, not in README

**Interface sketch:**
```typescript
// Definition
export const serverEnv = defineEnv({
  BB_SERVER_PORT: { type: "number", default: 3334 },
  BB_ROOT: { type: "string", default: "~/.bb" },
  BB_RUNTIME_MODE: { type: "enum", values: ["development", "production"], default: "production" },
  BB_ENV_DAEMON_AUTH_TOKEN: { type: "string", required: true },
  BB_ENV_DAEMON_SESSION_URL: { type: "string", optional: true },
  BB_SERVER_URL: { type: "string", optional: true },
});

// Usage — typed, validated
const port = serverEnv.BB_SERVER_PORT; // number
```

**Dependencies:** None (or envsafe if we want to use it directly).

### `packages/server-contract`

The complete HTTP contract for the server. Defines every route the server exposes, with Zod schemas and typed hc() clients.

**Two surfaces:**

1. **Public API** (`/api/v1/*`) — consumed by `apps/app` and `apps/cli`
   - Projects CRUD
   - Threads CRUD + operations (tell, stop, archive, queue)
   - Environments + operations
   - System (status, health, models, shutdown, restart)
   - Thread timeline, events, git-diff, work-status

2. **Internal API** (`/internal/*`) — consumed by env-daemon processes
   - Session open / welcome
   - Session messages (heartbeat, event_batch, command_ack, command_result, provider_request, session_close)
   - Session commands (long-poll)
   - Bearer token auth

**Contains:**
- Zod schemas for all request and response payloads
- Types derived from schemas via `z.infer<>`
- Route type definitions (`ApiSchema`, `InternalSchema`)
- `createPublicApiClient(baseUrl)` — hc() client for public API
- `createInternalApiClient(baseUrl, authToken)` — hc() client for internal API
- Session protocol types (what's currently in `env-daemon-contract/session-protocol.ts`)
- WebSocket subscription protocol types

**Dependencies:** `packages/domain`, `zod`, `hono`

### `packages/env-daemon-contract`

The HTTP contract for the environment daemon's control endpoint. The server makes requests TO the daemon.

**Surface:** The daemon's HTTP server that accepts control requests from the server.

**Contains:**
- Route type definitions for daemon control endpoint
- Zod schemas for control requests/responses
- `createDaemonControlClient(baseUrl, authToken)` — hc() client
- Command types: `EnvironmentDaemonCommand` (discriminated union of provider.ensure, thread.start, thread.resume, etc.)
- Event types: `EnvironmentDaemonEvent` (discriminated union)
- Command envelope, ack, delivery state types
- Status snapshot type

**Dependencies:** `packages/domain`, `zod`, `hono`

## Migration Strategy

### Phase 1: Foundation packages (no breaking changes)

1. Create `packages/domain` — extract pure types from `packages/core`
2. Create `packages/logger` — new package
3. Create `packages/env` — new package
4. Keep `packages/core` as a re-export shim so nothing breaks yet

### Phase 2: Contract packages

5. Create `packages/server-contract` — merge public API + internal session contracts
6. Redefine `packages/env-daemon-contract` — daemon control endpoint contract
7. Update `apps/app` and `apps/cli` to import from `server-contract`

### Phase 3: Delete and rebuild

8. Delete `packages/core` (replaced by `domain`)
9. Delete `packages/environment-daemon` (protocol in contracts, runtime rebuilt)
10. Delete `packages/environment` (rebuilt)
11. Delete `packages/api-contract` (replaced by `server-contract`)
12. Delete `apps/server/src/` (rebuilt from contracts)
13. Delete repository layer from `packages/db`

### Phase 4: Rebuild services

14. Rebuild `apps/server` from contracts — small, focused services
15. Rebuild environment daemon runtime
16. Rebuild environment provisioning

### Phase 5: Fix provider-adapters boundary

17. Define clean public API for `packages/provider-adapters`
18. Hide internal adapter implementations behind the public interface

## Consolidate QA

Fold `qa/` into `qa/README.md`:
- Server lifecycle (startup, shutdown, restart)
- Thread lifecycle (spawn, tell, stop, archive)
- Environment provisioning (local, docker, worktree)
- Env-daemon session protocol (open, heartbeat, commands, events)
- Provider integration (codex, claude-code, pi)
- E2E scenarios (multi-thread, shared environment, recovery)

## Open Questions

- **`toUIMessages` / `formatTimelineAsText` / `buildThreadDetailRows`**: These are view-layer transforms. Do they go in `ui-core`, `apps/app`, or a new `thread-ui` package? The CLI also uses `formatTimelineAsText`.
- **Provider adapter boundary**: What should the clean public API look like? Current consumers reach into `createProviderAdapter`, adapter-specific types, generated schemas. What's the right abstraction?
- **WebSocket protocol**: Currently in `packages/core/protocol.ts`. Moves to `server-contract` since it's a server concern? Or stays in `domain` since both app and server need the types?
- **`PromptInput` Zod schema**: Currently in `packages/core/schemas.ts`, used by both route validation and command validation. Goes in `server-contract`? Or `domain` (as one of the few schemas that lives with types)?
- **Phasing**: Do we do Phase 3 (delete) before Phase 4 (rebuild), leaving a broken codebase? Or interleave them — rebuild each service as we delete the old one?
