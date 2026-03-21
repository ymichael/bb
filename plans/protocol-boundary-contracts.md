# Protocol Boundary Contracts

Consolidates `env-daemon-session-protocol-cleanup.md` and `internal-protocol-normalization-audit.md`.

## Goal

Every protocol boundary has a Zod-first contract package. Validation happens at boundaries, not inside business logic. Internal code works with typed data — no `unknown`, no defensive parsing, no normalization.

## Principles

- **Single source of truth** — each boundary has one contract package with Zod schemas, inferred types, and typed client
- **Validate at the edge** — request AND response validation at protocol boundaries
- **No unknowns internally** — after crossing a boundary, data is typed. No `toRecord()`, `getStringField()`, or fallback key chains inside business logic
- **No type duplication** — types are derived from schemas via `z.infer<>`, not maintained in parallel

## Current State

| Boundary | Contract Package | Request Validation | Response Validation | Status |
|----------|-----------------|-------------------|--------------------|----|
| Public HTTP API (server ↔ app/CLI) | `@bb/api-contract` | Partial (Zod on some routes) | None | Type-only, no runtime validation |
| Env-daemon session (server ↔ daemon) | None (schemas in `@bb/environment-daemon`) | Yes (zValidator) | None (manual JSON parsing) | Schemas exist but no contract package |
| Env-daemon ↔ provider | `@bb/provider-adapters` | N/A (stdio/process) | Via adapter `translateEvent` | Done — adapters are the boundary |

### Dead code to remove
- `packages/core/src/unknown-helpers.ts` — `toRecord()`, `getStringField()`, `isRecord()` used in 9 files (~30 call sites)
- `packages/core/src/wire-decoders.ts` — `decodeThreadIdFromWireValue()`, `decodeSystemShutdownBlockedResponse()` (4 callers)
- `packages/core/src/types.ts` — `ProviderEventEnvelope`, `ProviderEventEnvelopeMetadata` (dead types)

## Implementation

### Part 1: Create `@bb/env-daemon-contract`

Move Zod schemas from `@bb/environment-daemon/session-protocol.ts` into a dedicated contract package. Replace the hand-rolled HTTP client with Hono's typed `hc()` client.

**New package: `packages/env-daemon-contract/`**
- Zod schemas for all session messages (moved from `session-protocol.ts`)
- Inferred TypeScript types via `z.infer<>`
- Hono route type definition
- Typed `hc()` client factory

**Delete:**
- `session-http-client.ts` (~250 lines) — replaced by `hc()` client
- `session-http-client.test.ts`

**Steps:**
1. Create `packages/env-daemon-contract` package
2. Move Zod schemas + types from `@bb/environment-daemon`
3. Define Hono route types matching server's env-daemon routes
4. Create `hc()` client factory
5. Replace `session-http-client.ts` usage in daemon with `hc()` client
6. Update server routes to import from `@bb/env-daemon-contract`

### Part 2: Move env-daemon routes to `/internal/*`

**Steps:**
1. Create bearer token auth middleware for `/internal/*`
2. Mount env-daemon routes under `/internal` instead of `/api/v1`
3. Update daemon client paths
4. Remove env-daemon stubs from `@bb/api-contract`

### Part 3: Strengthen `@bb/api-contract`

Add Zod response schemas so clients get validated responses. This eliminates `wire-decoders.ts`.

**Steps:**
1. Add response Zod schemas for all public API routes
2. Update `createApiClient()` to validate responses
3. Replace `decodeSystemShutdownBlockedResponse` with typed API contract response
4. Replace `decodeThreadIdFromWireValue` callers with typed data
5. Delete `wire-decoders.ts`

### Part 4: Rename `agent*` → `environmentDaemon*`

"Agent" is overloaded — it means AI agent everywhere except the env-daemon session protocol where `agentId` means daemon process ID.

| Current | New |
|---------|-----|
| `agentId` | `environmentDaemonId` |
| `agentInstanceId` | `environmentDaemonInstanceId` |
| `agentObservedAt` | `environmentDaemonObservedAt` |
| `agent_shutdown` | `daemon_shutdown` |

**Steps:**
1. DB migration renaming columns + index
2. Update `@bb/env-daemon-contract` schemas
3. Update daemon + server + CLI code
4. Update tests

### Part 5: Remove `channelId` abstraction

The environment channel is unused — events and commands all route through thread channels. Replace `channelId` with `threadId` everywhere.

**Steps:**
1. Delete `session-channels.ts`
2. Rename `channelId` → `threadId` in contract schemas
3. Remove environment channel init from daemon supervisor
4. Simplify server session service
5. Update tests

### Part 6: Eliminate `unknown-helpers.ts`

After parts 1-5, all protocol boundaries validate with Zod. Internal code should no longer need defensive parsing.

**Steps:**
1. Audit remaining `toRecord()`/`getStringField()` call sites
2. Replace each with typed access (data should be typed by the boundary that produced it)
3. Delete `unknown-helpers.ts`
4. Remove re-exports from `@bb/core`

### Part 7: Clean up dead types

- Delete `ProviderEventEnvelope` and `ProviderEventEnvelopeMetadata` from `types.ts`
- Delete `PROVIDER_EVENT_ENVELOPE_SCHEMA` and `PROVIDER_EVENT_ENVELOPE_VERSION` constants
- Remove any remaining `PersistedThreadEventData` indirection

## Validation

- `pnpm exec turbo run typecheck`
- `pnpm exec turbo run test` for all affected packages
- QA pass per `qa/env-daemon/` surface docs

## Open Questions

- **Part 2 auth**: Shared secret via `BB_ENV_DAEMON_AUTH_TOKEN` env var — both server and daemon read it. Simple bearer token validation.
- **Part 5 empty channels**: After removing environment channel, sessions open with `channels: []`. Threads get added dynamically when they attach. Need to verify this path works.
- **Part 3 scope**: Should response validation be opt-in (dev/test only) or always-on? Always-on is safer but adds latency. Could use `z.parse` in dev and `z.safeParse` with logging in prod.
