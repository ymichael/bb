# Quick Wins

## Goal
Track low-effort, high-value improvements that can be shipped independently.

## Scope
Small, self-contained changes — each item should be completable in a single session.

## Items

### 1. Context & token usage reporting for Claude Code and Pi (critical)
**Status:** Not started
**Priority:** Critical

Both bridges discard token/context usage data that their SDKs already provide. The entire downstream pipeline (`thread/tokenUsage/updated` → orchestrator → timeline API → `ThreadContextWindowIndicator` UI) already works for Codex.

**Claude Code:**
- `SDKResultMessage` includes `usage` (input/output/cache tokens), `modelUsage` (per-model with `contextWindow`), and `total_cost_usd`
- `event-translator.ts` only extracts `subtype` from result messages — everything else is dropped
- Fix: emit `thread/tokenUsage/updated` notification from the result handler in `event-translator.ts`

**Pi:**
- `AgentSession.getSessionStats()` returns cumulative tokens + cost
- `AgentSession.getContextUsage()` returns `{ tokens, contextWindow, percent }`
- Every `AssistantMessage` in `agent_end` events carries per-turn `usage` with input/output/cache tokens
- Fix: after each `agent_end` in `event-translator.ts` / `sdk-session.ts`, call `getContextUsage()` and extract the last message's `usage`, then emit `thread/tokenUsage/updated`

**Implementation Steps:**
- Map SDK usage fields to the existing `TokenUsageBreakdown` shape (`totalTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`)
- Include `modelContextWindow` from `modelUsage.contextWindow` (Claude Code) or `getContextUsage().contextWindow` (Pi)
- Emit the notification at turn completion for both bridges

**Validation:**
- Unit tests: verify bridges emit `thread/tokenUsage/updated` with correct shape
- Manual QA: run a thread with each provider and confirm the context window indicator appears in the UI

---

### 2. Dynamic model list for Pi provider
**Status:** Not started

The Pi adapter (`packages/agent-server/src/pi-provider-adapter.ts`) returns a hardcoded 3-model list. The `@mariozechner/pi-ai` SDK (already installed at v0.58.3) exports `getProviders()` and `getModels(provider)` — a typed catalog of all models Pi supports.

**Implementation Steps:**
- In the pi-bridge, call `getProviders()` + `getModels()` to build the available model list from the SDK catalog
- Either add a `model/list` JSON-RPC method to the pi-bridge (matching the Codex pattern), or call the SDK directly in the adapter
- Filter to providers the user has credentials for (Pi stores auth in `~/.pi/agent/auth.json`)
- Map Pi model metadata to `AvailableModel` shape (reasoning efforts, display names, etc.)

**Validation:**
- Update `pi-provider-adapter.test.ts` to verify dynamic listing
- Manual QA: switch to Pi provider in UI and confirm model selector populates dynamically

**Open Questions/Risks:**
- Pi's catalog is compiled into the package — updates come with dependency bumps, not live. Still far better than our manual 3-model list.
- Need to decide whether to filter by credential availability or show all models (with errors on use).

---

### 3. Dynamic model list for Claude Code provider
**Status:** Not started

The Claude Code adapter (`packages/agent-server/src/claude-code-provider-adapter.ts`) returns a hardcoded 3-model list. Anthropic has a `GET /v1/models` API endpoint that returns all models available to the caller's account.

**Implementation Steps:**
- Call the Anthropic models API directly from the adapter using the existing `ANTHROPIC_API_KEY` or OAuth token
- Filter response to agent-relevant models (Claude family, skip embeddings)
- Map to `AvailableModel` shape — will need a small metadata mapping for `supportedReasoningEfforts` and `displayName` since the API doesn't return those

**Open Questions/Risks:**
- Bedrock (`CLAUDE_CODE_USE_BEDROCK`) and Vertex (`CLAUDE_CODE_USE_VERTEX`) have their own model listing APIs — may need provider-aware branching or only use dynamic listing for the direct API path.
- Reasoning effort metadata isn't in the models API response — need a static mapping overlay.

---

### 4. Pi dynamic tool schema parity
**Status:** Not started

Pi's `tool-proxy.ts` only handles flat schemas (`string`, `number`, `boolean`). Nested `object` and `array` types are not converted, and all fields become `Type.Optional()`. This causes dynamic tools with complex schemas to silently degrade.

**Implementation Steps:**
- Extend the schema converter in `packages/pi-bridge/src/tool-proxy.ts` to handle `object` (recursive), `array`, and `enum` types
- Respect `required` fields from the input JSON Schema instead of making everything optional
- Add unit tests for nested/complex schemas

**Validation:**
- Unit tests with nested object schemas, array schemas, required fields
- Manual QA: register a dynamic tool with complex schema and verify Pi receives it correctly

---

### 5. Pi thread resume (not actually broken — just not wired up)
**Status:** Not started

The pi-bridge currently uses `SessionManager.inMemory()` and comments say "Pi in-memory sessions don't support resume, so just start fresh." But the Pi SDK **does** support file-backed persistent sessions — the sibling `swarm` project (`../swarm`) uses `SessionManager.open(filePath)` to persist and resume sessions via JSONL session files.

**Implementation Steps:**
- Replace `SessionManager.inMemory()` with `SessionManager.open(sessionFilePath)` in `packages/pi-bridge/src/sdk-session.ts`
- Determine session file path — either passed from daemon via `thread/start` params or derived from threadId
- On `thread/resume`, open the existing session file so history is automatically restored
- Optionally use Pi's custom entry system to persist bridge-specific metadata (turnId counters, etc.)

**Reference:** See `swarm/apps/backend/src/swarm/agent-runtime.ts` for the working implementation.

**Validation:**
- Unit test: start a session, send turns, stop, resume — verify conversation history is present
- Manual QA: start a Pi thread, have a conversation, resume the thread and confirm the agent remembers context

**Open Questions/Risks:**
- Need to decide where session files live (temp dir? project-scoped dir?)
- Bridge currently sets `process.env` globally for env vars — safe because one bridge = one thread, but session file persistence may interact with this assumption
