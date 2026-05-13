# Extensions System

## Goal

Allow users to extend bb with custom providers, environments, and lifecycle hooks without forking the repo. Extensions are TypeScript modules discovered from `.bb/extensions/` (project-local) and `~/.bb/extensions/` (global), loaded at server startup alongside the built-in registrations.

## Scope

**v1 (MVP):**

- Extension discovery and loading from `.bb/extensions/` and `~/.bb/extensions/`
- `registerProvider()` — plug custom provider adapters into the provider registry alongside the built-in `codex`, `claude-code`, and `pi` providers
- `registerEnvironment()` — plug custom environment definitions into the `EnvironmentRegistry` alongside the built-in `local` and `docker` kinds
- Examples directory in the repo with working provider and environment extensions
- TypeScript extensions loaded without compilation (via jiti or tsx)

**v1.5 (fast follow):**

- Lifecycle event hooks (`on("thread:spawn")`, `on("turn:complete")`, etc.)
- `registerTool()` — custom tools surfaced through `ProviderToolHost` and available to agents
- Extension-scoped configuration via `.bb/extensions/<name>/config.json`

**Not v1:**

- npm/git package distribution
- UI extensions (custom tabs, panels)
- Hot reload
- Extension marketplace

## Design

### Extension API

An extension is a TypeScript file that exports a default function receiving an `ExtensionAPI` handle:

```typescript
import type { ExtensionAPI } from "@bb/core";

export default function (bb: ExtensionAPI) {
  bb.registerProvider({
    id: "gemini",
    displayName: "Gemini",
    capabilities: { supportsRename: false, supportsServiceTier: false },
    processCommand: "npx",
    processArgs: ["gemini-mcp-bridge"],
    // ... remaining ProviderAdapter members
  });

  bb.registerEnvironment({
    kind: "e2b",
    info: {
      id: "e2b",
      displayName: "E2B Sandbox",
      capabilities: {
        host_filesystem: false,
        isolated_workspace: true,
        squash_merge: false,
      },
    },
    create(context) {
      /* ... */
    },
    restore(state, context) {
      /* ... */
    },
    isState(value): value is E2BState {
      /* ... */
    },
  });
}
```

### Discovery & Loading

Extensions are auto-discovered from two locations:

| Location                      | Scope                     |
| ----------------------------- | ------------------------- |
| `.bb/extensions/*.ts`         | Project-local             |
| `.bb/extensions/*/index.ts`   | Project-local (directory) |
| `~/.bb/extensions/*.ts`       | Global (all projects)     |
| `~/.bb/extensions/*/index.ts` | Global (directory)        |

**Loading order:** Global extensions first, then project-local. Project-local can override global (e.g., a project-local provider with the same ID wins).

**Runtime:** Extensions are loaded via [jiti](https://github.com/unjs/jiti) — TypeScript works without compilation, and npm dependencies resolve from a `package.json` in the extension directory.

### Provider Extensions

A provider extension implements the `ProviderAdapter` interface from `@bb/provider-adapters`. The interface is process-oriented — each provider tells bb how to spawn its bridge process and how to build/interpret the JSON-RPC messages. The `id` field is a plain `string`, so extension providers don't need to modify the built-in `ThreadProviderId` union.

The package exports adapter helpers (`baseNotificationResult`, `withExecutionOptions`, `normalizeProviderEventType`, etc.) that handle common patterns, so a minimal provider can be ~40 lines:

```typescript
import {
  baseNotificationResult,
  deriveThreadTitleFromInput,
  normalizeProviderEventType,
  registerProvider,
  resolveBaseInstructions,
  withExecutionOptions,
  withThreadEnvironmentPolicy,
  type ProviderAdapter,
  type ProviderNotification,
  type ProviderNotificationResult,
} from "@bb/provider-adapters";

function createGeminiAdapter(): ProviderAdapter {
  return {
    id: "gemini",
    displayName: "Gemini",
    capabilities: { supportsRename: false, supportsServiceTier: false },
    processCommand: "npx",
    processArgs: ["@google/gemini-mcp-bridge"],
    clientInfo: { name: "bb", version: "1.0.0" },

    buildInitializeCommand(clientInfo) {
      return { method: "initialize", params: { clientInfo } };
    },
    buildThreadStartCommand(req, context) {
      return {
        method: "thread/start",
        params: withExecutionOptions(
          withThreadEnvironmentPolicy(
            {
              baseInstructions: resolveBaseInstructions(
                req.developerInstructions,
              ),
            },
            context,
          ),
          req,
        ),
      };
    },
    buildThreadResumeCommand(providerThreadId, context, options) {
      return {
        method: "thread/resume",
        params: withExecutionOptions(
          { threadId: providerThreadId ?? context.threadId },
          options,
        ),
      };
    },
    buildTurnStartCommand(threadId, providerThreadId, input, options) {
      return {
        method: "turn/start",
        params: withExecutionOptions(
          { threadId: providerThreadId ?? threadId, input },
          options,
        ),
      };
    },
    interpretNotification(
      notification: ProviderNotification,
    ): ProviderNotificationResult {
      const normalized = normalizeProviderEventType(notification.method);
      let status;
      if (normalized === "turn/started") status = "active" as const;
      else if (normalized === "turn/completed") status = "idle" as const;
      else if (normalized === "error") status = "error" as const;
      return baseNotificationResult(notification.method, { status });
    },
    extractProviderThreadId(data) {
      return typeof data.threadId === "string" ? data.threadId : undefined;
    },
    outputFromEvent: () => undefined,
    listModels: async () => [],
    deriveThreadTitle: (input) => deriveThreadTitleFromInput(input),
    inactiveSessionErrorMessage: (id) =>
      `No active Gemini session for thread ${id}`,
  };
}

// Register via the extension API or directly:
registerProvider("gemini", createGeminiAdapter);
```

The `ProviderAdapter` is consumed by `ProviderSessionController` in `apps/server/src/provider-session-controller.ts`, which manages the child-process lifecycle, JSON-RPC framing, and event routing. Extension providers register via `registerProvider()` from `@bb/provider-adapters` and plug in at the same level as the built-in codex, claude-code, and pi providers.

**Key design decision:** Extension providers implement the same `ProviderAdapter` interface as built-ins. The registry is dynamic (`registerProvider(id, factory)`), so extensions don't require changes to any built-in files. See `packages/provider-adapters/README.md` for the full contract documentation and implementation guide.

### Environment Extensions

An environment extension implements the `EnvironmentDefinition<TState>` interface from `packages/environment/src/contracts.ts` and registers it on the `EnvironmentRegistry`:

```typescript
import type {
  EnvironmentDefinition,
  CreateEnvironmentContext,
  IEnvironment,
} from "@bb/environment";

interface E2BState {
  sandboxId: string;
  workspaceRoot: string;
}

const e2bDefinition: EnvironmentDefinition<E2BState> = {
  kind: "e2b",
  info: {
    id: "e2b",
    displayName: "E2B Sandbox",
    capabilities: {
      host_filesystem: false,
      isolated_workspace: true,
      squash_merge: false,
    },
  },
  create(context: CreateEnvironmentContext): IEnvironment {
    // Provision a new E2B sandbox
    // Must return an object implementing the full IEnvironment interface:
    //   kind, info, serialize(), suspend(), destroy(), exists(),
    //   supportsHostFilesystemAccess(), isIsolatedWorkspace(),
    //   getAgentConnectionTarget(), getCheckoutSnapshot(),
    //   getWorkspaceRootUnsafe(), run(), spawn(),
    //   getWorkspaceStatus(), watchWorkspaceStatus(),
    //   commitWorkspace(), getWorkspaceDiff(), ...
  },
  restore(state: E2BState, context: CreateEnvironmentContext): IEnvironment {
    // Rehydrate from persisted state (returned by serialize())
  },
  isState(value: unknown): value is E2BState {
    return (
      !!value &&
      typeof value === "object" &&
      "sandboxId" in value &&
      typeof (value as any).sandboxId === "string"
    );
  },
};
```

The `EnvironmentRegistry` class already supports dynamic registration via `registry.register(definition)`. Built-in definitions are `local` (from `createLocalEnvironmentDefinition`) and `docker` (from `createDockerEnvironmentDefinition`), both registered in `createDefaultEnvironmentRegistry()` at `packages/environment/src/default-registry.ts`.

Extension environments also need a corresponding entry in the provisioning system catalog (`SystemEnvironmentInfo[]`) so they appear in `listEnvironments()` on the API. The extension loader will append these entries to the `environmentCatalog` array passed to the `Orchestrator` constructor.

### Extension Configuration

Extensions that need configuration can read from their own directory:

```
.bb/extensions/
  gemini/
    index.ts          # extension entry point
    config.json       # extension-specific config (read by the extension itself)
    package.json      # npm dependencies (optional)
```

bb does not impose a config schema — each extension reads its own config. This keeps the core simple and lets extensions own their configuration format.

### Error Isolation

Extensions run in the server process. To prevent a broken extension from crashing the server:

1. Extension loading is wrapped in try/catch — a failing extension logs an error and is skipped
2. Provider/environment calls from extensions are wrapped similarly — errors are surfaced as thread-level errors, not server crashes
3. No worker thread isolation for v1 (keep it simple), but the try/catch boundary is sufficient for most failure modes

### Examples Directory

Ship working examples in the repo:

```
examples/extensions/
  providers/
    gemini/
      index.ts        # Gemini provider implementing ProviderAdapter
      config.json     # { "apiKey": "..." } or env var reference
      package.json    # depends on @google/genai
  environments/
    e2b/
      index.ts        # E2B sandbox implementing EnvironmentDefinition<E2BState>
      config.json
      package.json    # depends on @e2b/code-interpreter
```

## Implementation Steps

### Step 1: Define the `ExtensionAPI` type in `@bb/core`

In `packages/core/src/`:

1. Create an `extension-api.ts` file defining the `ExtensionAPI` interface:

   ```typescript
   import type { ProviderAdapter } from "./runtime-contracts.js";
   import type {
     SystemEnvironmentInfo,
     ProviderCapabilities,
   } from "./api-types.js";

   export interface ExtensionProviderRegistration extends ProviderAdapter {
     // id is widened to string (not restricted to ThreadProviderId)
     id: string;
   }

   export interface ExtensionEnvironmentRegistration {
     kind: string;
     info: SystemEnvironmentInfo;
     // The actual EnvironmentDefinition will be imported from @bb/environment
     // at the loading layer; this type captures the shape extensions must provide
   }

   export interface ExtensionAPI {
     registerProvider(adapter: ExtensionProviderRegistration): void;
     registerEnvironment(definition: ExtensionEnvironmentRegistration): void;
   }
   ```

2. Export `ExtensionAPI` from the package index

### Step 2: Widen `ThreadProviderId` for extension providers

The built-in provider IDs are a closed union (`"codex" | "claude-code" | "pi"`) in `packages/core/src/thread-provider.ts`. Extension provider IDs cannot be part of this compile-time union.

1. Change the `ProviderAdapter.id` field type to `string` (or `ThreadProviderId | string` — effectively `string`) in `runtime-contracts.ts`. The built-in `ProviderAdapter` factory functions already return specific IDs, so type safety is preserved at construction.
2. In the `provider_id` column of the threads table (`packages/db/`), the column is already `TEXT` — no schema change needed. The `isThreadProviderId()` guard remains useful for checking whether a provider is built-in.
3. Update `createProviderForId()` in `packages/provider-adapters/src/provider-registry.ts` to consult an extension registry fallback when the ID is not a built-in.

### Step 3: Extension discovery & loading in `apps/server/`

1. Add `jiti` as a dependency of `@bb/server` for TypeScript loading without compilation
2. Create `apps/server/src/extension-loader.ts`:
   - Scan `.bb/extensions/` (relative to each registered project's `rootPath`) and `~/.bb/extensions/` for `.ts` files and `*/index.ts` directories
   - For each discovered file, load it via jiti and call the default export with an `ExtensionAPI` instance
   - Collect registered providers and environment definitions
   - Wrap each load in try/catch with error logging; skip broken extensions
3. The `ExtensionAPI` implementation accumulates registrations into arrays:

   ```typescript
   const extensionProviders: ProviderAdapter[] = [];
   const extensionEnvironmentDefinitions: EnvironmentDefinition<unknown>[] = [];

   const api: ExtensionAPI = {
     registerProvider(adapter) {
       extensionProviders.push(adapter);
     },
     registerEnvironment(definition) {
       extensionEnvironmentDefinitions.push(definition);
     },
   };
   ```

### Step 4: Wire extension registrations into server startup

In `apps/server/src/server.ts` (`createServer()`):

1. After creating the default `environmentRegistry` via `createDefaultEnvironmentRegistry()`, register any extension-provided `EnvironmentDefinition` entries on it:
   ```typescript
   for (const def of extensionEnvironmentDefinitions) {
     environmentRegistry.register(def);
   }
   ```
2. After building `providerCatalog` from `listAvailableProviderInfos()`, append `SystemProviderInfo` entries for each extension provider:
   ```typescript
   for (const adapter of extensionProviders) {
     providerCatalog.push({
       id: adapter.id,
       displayName: adapter.displayName,
       capabilities: { ...adapter.capabilities },
     });
   }
   ```
3. Extend the `ProviderSessionController` setup so that when a thread requests an extension provider ID, the corresponding `ProviderAdapter` is used. This requires the `Orchestrator` (or a new provider-resolution layer) to look up the correct adapter by ID. Currently `createServer()` creates a single `ProviderSessionController` bound to one `ProviderAdapter`. For multi-provider extension support:
   - Introduce a `ProviderAdapterRegistry` (a `Map<string, ProviderAdapter>`) populated with built-in + extension adapters
   - The orchestrator resolves the adapter per-thread based on `thread.providerId`, creating a `ProviderSessionController` on demand or selecting from a pool
4. Similarly, append `SystemEnvironmentInfo` entries for extension environments to `environmentCatalog` so they appear in `listEnvironments()`.

### Step 5: Run extension loading at the right lifecycle point

In `apps/server/src/index.ts` (`main()`):

1. After database migration and repository construction, but before `createServer()`, run extension discovery:
   ```typescript
   const { providers, environments } = await loadExtensions({
     projectRepo,
     globalExtensionsDir: resolve(homedir(), ".bb", "extensions"),
     logger: console,
   });
   ```
2. Pass the results into `createServer()` via new fields on `ServerDeps`:
   ```typescript
   interface ServerDeps {
     // ... existing fields ...
     extensionProviders?: ProviderAdapter[];
     extensionEnvironmentDefinitions?: EnvironmentDefinition<unknown>[];
   }
   ```

### Step 6: Write examples

1. Write a working Gemini provider extension implementing the full `ProviderAdapter` interface from `@bb/core` (the process-based MCP bridge pattern)
2. Write a working E2B environment extension implementing `EnvironmentDefinition<E2BState>` and returning an `IEnvironment` from `create()`/`restore()`
3. Each example includes setup instructions for installing dependencies and configuring API keys
4. Test each example end-to-end: install extension, start server, spawn thread with extension provider/environment

### Step 7: Document

1. Add extension docs (can be a `docs/extensions.md` or section in README)
2. Document the `ExtensionAPI` interface and the full `ProviderAdapter` / `EnvironmentDefinition<T>` contracts
3. Document the discovery paths and loading behavior
4. Link to examples

## Validation

1. **Unit test — provider registration:** Write a test extension that registers a mock provider adapter. Verify it appears in the `listProviders()` API response alongside the built-in `codex`, `claude-code`, and `pi` entries.
2. **Unit test — environment registration:** Write a test extension that registers a mock `EnvironmentDefinition`. Verify `EnvironmentRegistry.has(kind)` returns true and `registry.list()` includes its `EnvironmentInfo`.
3. **Fault tolerance:** Verify a broken extension (throws on load) does not crash the server — the server starts normally with the broken extension logged and skipped.
4. **ID conflict:** Verify that registering a provider with a built-in ID (`"codex"`, `"claude-code"`, `"pi"`) logs a warning and is rejected.
5. **E2E — extension provider:** With the Gemini example installed, spawn a thread with `providerId: "gemini"` and verify the MCP bridge process launches and events flow.
6. **E2E — extension environment:** With the E2B example installed, spawn a thread with `environmentCreationArgs: { kind: "e2b" }` and verify provisioning completes.
7. **Scoping:** Verify project-local extensions are only loaded for threads in that project, not for other projects on the same server.

## Open Questions/Risks

- **Provider interface complexity:** RESOLVED. The `ProviderAdapter` interface was restructured to ~15 methods with shared helpers (`baseNotificationResult`, `withExecutionOptions`, etc.) that handle common patterns. A minimal provider is ~40 lines. See `packages/provider-adapters/README.md`.
- **`ProviderAdapter.id` type widening:** RESOLVED. `ProviderAdapter.id` is now `string`. The `isThreadProviderId()` guard discriminates built-in vs extension providers. The provider registry is dynamic via `registerProvider()`.
- **Per-thread provider resolution:** The current `createServer()` creates one `ProviderSessionController` bound to a single `ProviderAdapter` (the default provider). Multi-provider support (extension or otherwise) requires either a controller pool keyed by provider ID, or a factory that creates controllers on demand. This is the largest architectural change for provider extensions.
- **Environment `IEnvironment` surface:** The `IEnvironment` interface has extensive requirements (git workspace operations, agent connection targets, spawn/run). Extension environments may only need a subset. Consider whether some methods can have no-op defaults or whether a base class / mixin simplifies implementation.
- **TypeScript loading:** jiti is battle-tested (used by Nuxt, etc.) but adds a dependency. Alternative: require extensions to be pre-compiled JS. Recommendation: use jiti — the DX of writing raw TypeScript is worth it.
- **Dependency resolution:** Extensions with `package.json` need their `node_modules` installed. The user runs `npm install` in their extension directory. bb does not manage this — document it. Future: could auto-install on discovery.
- **Provisioning system integration:** Extension environments need to work with the `resolveProvisioningSelection()` machinery in `apps/server/src/environment-provisioning-systems.ts`. The current built-in provisioning systems (`reuse-existing`, `direct-path`, `worktree`, `docker`) are a hardcoded array. Extension environments will either need to register a corresponding `EnvironmentProvisioningSystem`, or the resolution fallback at the bottom of `resolveProvisioningSelection()` needs to be made extension-aware.
- **Server restart on extension change:** v1 requires a server restart to pick up new or changed extensions. Document this clearly. Hot reload is deferred.
