# Extensions System

## Goal

Allow users to extend bb with custom providers, environments, and lifecycle hooks without forking the repo. Extensions are TypeScript modules discovered from `.bb/extensions/` (project-local) and `~/.bb/extensions/` (global), following the same model as Pi's extension system.

## Scope

**v1 (MVP):**
- Extension discovery and loading from `.bb/extensions/` and `~/.bb/extensions/`
- `registerProvider()` — plug custom provider adapters into the provider registry
- `registerEnvironment()` — plug custom environment adapters into the environment registry
- Examples directory in the repo with working provider and environment extensions
- TypeScript extensions loaded without compilation (via jiti or tsx)

**v1.5 (fast follow):**
- Lifecycle event hooks (`on("thread:start")`, `on("turn:complete")`, etc.)
- `registerTool()` — custom tools available to agents
- Extension-scoped configuration via `.bb/extensions/<name>/config.json`

**Not v1:**
- npm/git package distribution
- UI extensions (custom tabs, panels)
- Hot reload
- Extension marketplace

## Design

### Extension API

An extension is a TypeScript file that exports a default function:

```typescript
import type { ExtensionAPI } from "@bb/agent-core";

export default function (bb: ExtensionAPI) {
  bb.registerProvider({
    id: "gemini",
    displayName: "Gemini",
    // ... adapter implementation
  });

  bb.registerEnvironment({
    kind: "e2b",
    displayName: "E2B Sandbox",
    // ... environment implementation
  });
}
```

### Discovery & Loading

Extensions are auto-discovered from two locations:

| Location | Scope |
|---|---|
| `.bb/extensions/*.ts` | Project-local |
| `.bb/extensions/*/index.ts` | Project-local (directory) |
| `~/.bb/extensions/*.ts` | Global (all projects) |
| `~/.bb/extensions/*/index.ts` | Global (directory) |

**Loading order:** Global extensions first, then project-local. Project-local can override global (e.g., a project-local provider with the same ID wins).

**Runtime:** Extensions are loaded via [jiti](https://github.com/unjs/jiti) (same as Pi uses) — TypeScript works without compilation, and npm dependencies resolve from a `package.json` in the extension directory.

### Provider Extensions

A provider extension implements the same adapter interface as the built-in providers (Codex, Claude Code, Pi). The `ExtensionAPI.registerProvider()` call adds it to the provider registry at daemon startup.

```typescript
bb.registerProvider({
  id: "gemini",                          // unique provider ID
  displayName: "Gemini",

  // Return available models
  listModels(): Promise<AvailableModel[]>,

  // Spawn a provider session for a thread
  createSession(opts: ProviderSessionOpts): Promise<ProviderSession>,
});
```

The `ProviderSession` interface matches what the existing adapters implement:
- Start/resume turns
- Stream events (mapped to bb's event system)
- Stop/cancel
- Report token usage

**Key design decision:** Provider extensions implement the same internal adapter interface, not a simplified wrapper. This keeps the extension surface small (one interface to document) and means extensions have full capability parity with built-in providers.

### Environment Extensions

An environment extension implements the environment contract:

```typescript
bb.registerEnvironment({
  kind: "e2b",                           // unique environment kind
  displayName: "E2B Sandbox",

  // Provision a new environment instance
  provision(opts: EnvironmentProvisionOpts): Promise<EnvironmentInstance>,

  // Attach to an existing environment
  attach(descriptor: EnvironmentDescriptor): Promise<EnvironmentInstance>,

  // Capabilities this environment supports
  capabilities: ["isolated_workspace", "promote_primary_checkout"],
});
```

### Extension Configuration

Extensions that need configuration can read from their own directory:

```
.bb/extensions/
  gemini/
    index.ts          # extension entry point
    config.json       # extension-specific config (read by the extension itself)
    package.json      # npm dependencies (optional)
```

bb doesn't impose a config schema — each extension reads its own config. This keeps the core simple and lets extensions own their configuration format.

### Error Isolation

Extensions run in the daemon process. To prevent a broken extension from crashing the daemon:

1. Extension loading is wrapped in try/catch — a failing extension logs an error and is skipped
2. Provider/environment calls from extensions are wrapped similarly — errors are surfaced as thread-level errors, not daemon crashes
3. No worker thread isolation for v1 (keep it simple), but the try/catch boundary is sufficient for most failure modes

### Examples Directory

Ship working examples in the repo:

```
examples/extensions/
  providers/
    gemini/
      index.ts        # Gemini provider via @google/genai SDK
      config.json      # { "apiKey": "..." } or env var reference
      package.json     # depends on @google/genai
      README.md
    opencode/
      index.ts        # OpenCode-compatible provider
      README.md
  environments/
    e2b/
      index.ts        # E2B sandbox environment
      config.json
      package.json     # depends on @e2b/code-interpreter
      README.md
    docker-compose/
      index.ts        # Docker Compose-based environment
      README.md
```

## Implementation Steps

### Step 1: Define the ExtensionAPI type

In `packages/agent-core`:
1. Define `ExtensionAPI` interface with `registerProvider()` and `registerEnvironment()` methods
2. Define the provider adapter interface that extensions implement (extract from existing adapter code)
3. Define the environment adapter interface that extensions implement (extract from existing contract)
4. Export these types from the package

### Step 2: Extension discovery & loading

In `apps/daemon`:
1. Add extension discovery logic — scan `.bb/extensions/` and `~/.bb/extensions/` for `.ts` files and `*/index.ts` directories
2. Add jiti as a dependency for TypeScript loading
3. Load each extension by calling its default export with an `ExtensionAPI` instance
4. Wrap loading in try/catch with error logging
5. Run discovery at daemon startup, after built-in providers/environments are registered

### Step 3: Wire into registries

1. **Provider registry**: Accept registrations from extensions via `registerProvider()`. Extension providers are added alongside built-in ones. If an extension registers a provider with a built-in ID, log a warning and skip (built-ins win, or decide: project-local wins).
2. **Environment registry**: Same pattern — `registerEnvironment()` adds to the existing registry.
3. Ensure the daemon's `listProviders` / `listEnvironments` APIs return extension-registered entries

### Step 4: Write examples

1. Write a working Gemini provider extension using `@google/genai`
2. Write a working E2B environment extension (or a simpler Docker Compose example)
3. Each example includes a README explaining setup and configuration
4. Test each example end-to-end: install extension, start daemon, spawn thread with extension provider/environment

### Step 5: Document

1. Add extension docs (can be a `docs/extensions.md` or section in README)
2. Document the `ExtensionAPI` interface
3. Document the discovery paths and loading behavior
4. Link to examples

## Validation

1. Write a test extension that registers a mock provider — verify it appears in `listProviders` API
2. Write a test extension that registers a mock environment — verify it appears in environment registry
3. Verify a broken extension (throws on load) doesn't crash the daemon
4. Verify the Gemini example works end-to-end (requires API key)
5. Verify project-local extensions are scoped to that project's daemon instance

## Open Questions/Risks

- **Provider interface stability**: The internal provider adapter interface wasn't designed for external consumption. Before shipping extensions, audit it for anything that's too internal or likely to change. May want a slightly simplified wrapper interface for v1 extensions, with the full interface available for power users.
- **Environment interface stability**: Same concern. The environment contract has capabilities, provisioning, and lifecycle — decide what subset extensions need for v1.
- **TypeScript loading**: jiti is battle-tested (used by Pi, Nuxt, etc.) but adds a dependency. Alternative: require extensions to be pre-compiled JS. Recommendation: use jiti — the DX of writing raw TypeScript is worth it.
- **Dependency resolution**: Extensions with `package.json` need their `node_modules` installed. The user runs `npm install` in their extension directory. bb doesn't manage this — document it. Future: could auto-install on discovery.
- **Provider ID conflicts**: If an extension tries to register `"codex"` as a provider ID, what happens? Recommendation: built-in IDs are reserved, extensions must use unique IDs. Log a warning and skip on conflict.
- **Thread type for extension providers**: Extension providers need to work with the existing `ThreadProviderId` union. Since this is `closed_internal`, extension provider IDs can't be part of it. Need a way to store arbitrary provider IDs in the DB for threads using extension providers — likely change the column to a plain string with the union as a known subset.
