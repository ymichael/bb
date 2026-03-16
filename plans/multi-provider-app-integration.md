# Multi-Provider App Integration

## Goal

Make providers a first-class user-facing concept: selectable per-project in the UI, per-thread via CLI flags, with all providers available simultaneously. Clean up env var naming, add CLI timeline rendering, and make manager spawning provider-aware.

## Scope

1. **Env var standardization**: Migrate `BEANBAG_*` to `BB_*`
2. **Provider selection in app**: Move from env var to per-project/per-thread runtime selection
3. **CLI timeline rendering**: Human-readable markdown timeline alongside raw JSON
4. **Manager modal**: Provider+model selection when hiring a manager

---

## 1. Env Var Standardization (`BEANBAG_*` → `BB_*`)

### Current state

Mixed naming across the codebase:
- `BEANBAG_ROOT` — daemon data directory
- `BEANBAG_PROVIDER` — provider selection (startup-time)
- `BEANBAG_E2E_PROVIDER_MODE` — test harness flag
- `BB_DAEMON_URL` — CLI target daemon
- `BB_PROJECT_ID` / `BB_THREAD_ID` — injected into agent env

### Target

All env vars use `BB_` prefix. `BEANBAG_*` vars are accepted as deprecated aliases with a stderr warning.

### Migration plan

1. **Inventory all env var references** across the codebase (daemon, CLI, bridges, tests, scripts, CI, docs).
2. **Create a shared `env.ts` helper** (in `@beanbag/agent-core` or a new `@beanbag/config` package):
   ```typescript
   export function getEnv(name: string): string | undefined {
     const bbName = name.startsWith("BB_") ? name : `BB_${name}`;
     const legacyName = bbName.replace(/^BB_/, "BEANBAG_");
     const value = process.env[bbName] ?? process.env[legacyName];
     if (process.env[legacyName] && !process.env[bbName]) {
       console.error(`Warning: ${legacyName} is deprecated, use ${bbName}`);
     }
     return value;
   }
   ```
3. **Update all consumers** to use the helper.
4. **Update docs/README** with the new names.
5. **Update test scripts** (`package.json` scripts, CI configs).

### Challenges

- **External consumers**: Users may have `BEANBAG_ROOT` in shell profiles. The deprecation alias + warning gives them time to migrate.
- **E2E test scripts**: `BEANBAG_E2E_PROVIDER_MODE` is used extensively in package.json scripts. Rename to `BB_E2E_PROVIDER_MODE` with alias.
- **Bridge env injection**: The bridges inject `BB_PROJECT_ID` etc. into agent environments — these are already `BB_*` prefixed, so no change needed there.

### Specific renames

| Old | New | Notes |
|---|---|---|
| `BEANBAG_ROOT` | `BB_ROOT` | |
| `BEANBAG_PROVIDER` | *(removed)* | Provider selection moves into the app. For tests: `BB_E2E_PROVIDER` |
| `BEANBAG_E2E_PROVIDER_MODE` | `BB_E2E_PROVIDER_MODE` | |
| `BEANBAG_LOG_LEVEL` | `BB_LOG_LEVEL` | |

`BB_DAEMON_URL`, `BB_PROJECT_ID`, `BB_THREAD_ID` stay as-is.

---

## 2. Provider Selection in App

### Current architecture

- Single provider chosen at daemon startup via `BEANBAG_PROVIDER` env var
- `ThreadManager` holds one `ProviderAdapter`
- All threads use the same provider
- Models are listed from that single provider

### Target architecture

- Daemon registers **all available providers** at startup (Codex, Claude Code, Pi)
- Each provider's availability is determined by runtime checks (is `codex` in PATH? Is `ANTHROPIC_API_KEY` set? Is `pi` auth configured?)
- Provider is selected **per-thread** at spawn time
- Default provider is configurable per-project (stored in project settings)
- UI shows a provider selector in the project-level prompt box
- CLI accepts `--provider` flag on `thread spawn`

### Data model changes

**threads table**: Already has `provider_id` column — this is set at spawn time and immutable for the thread's lifetime. No schema change needed.

**projects table**: Add `default_provider_id` column (nullable, falls back to system default).

**API changes**:

- `GET /api/v1/system/providers` — already exists, returns all registered providers
- `GET /api/v1/system/provider` — currently returns the single active provider; deprecate or make it return the system default
- `POST /api/v1/threads` (`SpawnThreadRequest`) — add optional `providerId` field
- `GET /api/v1/projects/:id` — include `defaultProviderId` in response
- `PATCH /api/v1/projects/:id` — allow setting `defaultProviderId`

### Daemon changes

**Multi-provider ThreadManager**:

Currently `ThreadManager` holds a single `ProviderAdapter`. Change to a `ProviderRegistry` that holds multiple adapters keyed by provider ID:

```typescript
interface ProviderRegistry {
  getProvider(id: string): ProviderAdapter | undefined;
  getDefaultProvider(): ProviderAdapter;
  listProviders(): ProviderAdapter[];
  isAvailable(id: string): boolean;
}
```

Thread spawn resolves provider: `request.providerId ?? project.defaultProviderId ?? registry.getDefaultProvider().id`

**Provider availability detection**:

At startup, register all providers. Don't pre-check auth — let them fail at runtime with a clear auth error if credentials are missing. The API response marks all registered providers and the UI shows them all. If a provider fails on first use, the thread gets a clear error message the user can act on.

Default ordering when no project default is set: Codex → Claude Code → Pi (first registered wins).

**Bridge process management**:

Currently one bridge process type. With multi-provider, the daemon needs to spawn the correct bridge process based on the thread's `provider_id`. The `ProviderAdapter` already carries `processCommand` and `processArgs` — this should work as-is since each thread's env-agent already uses the adapter from the thread's provider.

### UI changes

**Project prompt box** (main view):

Add a provider selector dropdown next to the existing model selector:
```
[Provider: Claude Code ▾] [Model: claude-sonnet-4 ▾] [________________________] [Send]
```

- Provider dropdown shows available providers with icons/labels
- Changing provider updates the model dropdown to show that provider's models
- Selection is stored as project default
- If only one provider is available, hide the dropdown

**Thread prompt box**:

No provider selector — the provider is locked to what was chosen at spawn time. Show the provider as a read-only badge/label.

**Thread timeline header**:

Show provider + model as metadata in the thread header so the user knows which provider is running.

### CLI changes

```bash
# Spawn with explicit provider
bb thread spawn --project <id> --provider claude-code --model claude-sonnet-4 --prompt "..."

# List available providers
bb providers list

# Set project default
bb project update <id> --default-provider pi
```

### Challenges

- **Model namespaces**: Different providers use different model ID formats. The model selector must be scoped to the selected provider. The API already handles this via `listModels()` per adapter.
- **Provider-specific capabilities**: Some providers don't support steer, multimodal, etc. The UI needs to adapt (disable steer button, hide image upload) based on the thread's provider capabilities. The `ProviderCapabilities` type already exists for this.
- **Mid-session provider changes**: Not supported. A thread's provider is immutable. If a user wants to switch providers, they start a new thread.
- **Default provider persistence**: Stored per-project in the DB. System-level default can be `BB_DEFAULT_PROVIDER` env var or auto-detected (first available).
- **Bridge process lifecycle**: Each thread type already gets its own env-agent with the correct bridge. Multi-provider doesn't change this — it just means different threads may have different bridge types running simultaneously.
- **Cost/auth visibility**: Users may want to know which API key is being used. Consider showing auth status per-provider in the providers list.

---

## 3. CLI Timeline Rendering

### Current state

- `bb thread log <id>` — dumps raw JSON events
- `bb thread output <id>` — shows final text output
- `bb thread status <id>` — shows thread metadata + recent events
- The web app uses `toUIMessages()` to project events into a rich timeline

### Target

Extend `bb thread log <id>` with `--format json|minimal|verbose` (default: `minimal`). The `minimal` and `verbose` formats render the same `toUIMessages()` projection as formatted terminal output. `json` is the current raw dump.

### Design

The projection logic already exists in `@beanbag/agent-core/src/to-ui-messages.ts`. The CLI just needs a renderer that maps `UIMessage` types to formatted text:

```
── User ──────────────────────────────────────
Fix the login bug in auth.ts

── Assistant ─────────────────────────────────
I'll look into the login bug. Let me start by reading the relevant files.

── Exploring (3 files) ────────────────────────
  Read src/auth.ts
  Read src/auth.test.ts
  Grep 'login' in src/

── Tool Call: Bash ────────────────────────────
  $ npm test -- --grep login
  ✓ 3 tests passed (1.2s)

── File Edit: src/auth.ts ─────────────────────
  Updated: src/auth.ts
  +  if (!user.verified) return null;

── Assistant ─────────────────────────────────
Fixed the login bug. The issue was...
```

### Implementation

1. **New formatter in `@beanbag/agent-core`**: `formatTimelineAsText(messages: UIMessage[]): string`
   - Maps each `UIMessage` kind to a text block
   - Uses ANSI colors when stdout is a TTY, plain text otherwise
   - Exploring groups show collapsed summary by default
   - Tool calls show command + truncated output
   - File edits show path + change summary
   - Supports `--verbose` flag to show full tool output

2. **CLI integration**: Extend `bb thread log <id>` with `--format` flag:
   - `--format json` — current raw event dump (backward compatible)
   - `--format minimal` — compact timeline, exploring groups collapsed, tool output truncated (default)
   - `--format verbose` — full timeline with complete tool output and diffs
   - Fetches events via daemon API, runs `toUIMessages()`, passes to `formatTimelineAsText()`

3. **Watch mode**: `bb thread log <id> --follow` streams new events via WebSocket

### Benefits

- **QA**: Run any provider, inspect timeline from CLI without a browser
- **Testing**: Can assert timeline shape in E2E tests without browser automation
- **Debugging**: Quick visual check that events are projecting correctly
- **Consistency**: Same projection logic used in web and CLI = same bugs surface in both

### Challenges

- **Terminal width**: Need to truncate/wrap intelligently. Use `process.stdout.columns`.
- **Large outputs**: Tool outputs can be huge. Default to truncated with `--verbose` for full.
- **Streaming**: Watch mode needs incremental rendering, not full re-render.
- **Color**: Use `chalk` or similar, respect `NO_COLOR` env var.

---

## 4. Manager Modal

### Current state

When "hiring a manager" (spawning a manager thread), the UI currently uses the project default provider and model. There's no provider/model selection UI.

### Target

When the user clicks "Hire Manager", show a modal:

```
┌─ Hire Manager ──────────────────────────────┐
│                                              │
│  Provider:  [Claude Code ▾]                  │
│  Model:     [claude-opus-4 ▾]                │
│                                              │
│  Instructions (optional):                    │
│  [________________________________________]  │
│                                              │
│            [Cancel]  [Hire Manager]          │
└──────────────────────────────────────────────┘
```

### Implementation

1. **Modal component**: New `HireManagerModal` in `@beanbag/app`
2. **Provider+model selectors**: Reuse the same `ProviderSelector` and `ModelSelector` components from the prompt box
3. **API**: `SpawnThreadRequest` already accepts `model` and will accept `providerId` after the multi-provider work
4. **Defaults**: Pre-populate with project defaults; user can override per-manager

### Challenges

- **Dependent on multi-provider work**: This modal only makes sense after providers are selectable per-thread.
- **Manager-specific model recommendations**: Some models are better for manager tasks (high-capability models like Opus). Consider showing a "recommended" badge.
- **Thread type**: Manager threads have `type: "manager"`. The provider selection should work identically regardless of thread type.

---

## Implementation Order

1. **Env var standardization** — Low risk, no API changes, can ship independently
2. **CLI timeline rendering** — Independent of provider work, high testing value
3. **Multi-provider daemon + API** — Core infrastructure change
4. **Provider selector UI** — Depends on #3
5. **Manager modal** — Depends on #4

Phases 1 and 2 can be done in parallel. Phase 3 is the big one. Phases 4 and 5 are UI work that follows naturally.

---

## Decisions (resolved)

1. **Provider availability**: Check at startup only. Don't try to guess auth ahead of time — let the provider respond with an auth error at runtime. Improve later if needed.

2. **Base instructions**: Rename `codexBaseInstructions` → `agentBaseInstructions` and share across all providers. Move into `packages/templates` so provider-specific customizations can be layered on later.

3. **Default provider ordering**: Codex → Claude Code → Pi (first available wins).

4. **`BB_PROVIDER` env var**: Remove entirely. For tests, use `BB_E2E_PROVIDER` (or similar) to force a specific provider in test suites. Not a user-facing env var.

5. **CLI timeline format**: `bb thread log <id> --format json|minimal|verbose` with `minimal` as default. No separate `bb thread timeline` subcommand.

6. **QA tiers**: Update `qa/daemon/standalone-daemon-qa.md` now with light/extended/full tier definitions.

## Open Risks

1. **Billing/usage**: With multiple providers, users may want per-provider usage tracking. Out of scope for now.

2. **Graceful degradation**: If a provider becomes unavailable mid-session (API key revoked, service down), the thread should error gracefully. Already handled by existing error paths.

---

## 5. CLAUDE.md

Create a root-level `CLAUDE.md` that points to `AGENTS.md`:

```markdown
See @AGENTS.md
```

This gives Claude Code (and similar tools) immediate access to our codebase guidelines without duplicating content.

---

## 6. QA Coverage Audit & Tiers

### What the "10/10" manual QA actually tested

The agents ran a **lightweight lifecycle pass** — not the full runbook. Here's what was covered vs what the runbook's minimum checklist requires:

| # | Runbook checklist item (lines 827-844) | Tested? |
|---|---|---|
| 1 | standalone daemon health | ✅ |
| 2 | project create, list, files | ✅ |
| 3 | local start | ✅ |
| 4 | local follow-up | ✅ |
| 5 | local steer after confirmed `turn/started` | ✅ |
| 6 | local stop then follow-up | ❌ |
| 7 | local blocked restart | ❌ |
| 8 | local forced restart + reconnect or error | ❌ |
| 9 | local follow-up after restart failure | ❌ |
| 10 | worktree start | ✅ |
| 11 | worktree follow-up | ✅ |
| 12 | worktree stop then follow-up | ❌ |
| 13 | worktree promote-status, promote, demote | ❌ |
| 14 | worktree archive + cleanup | ❌ |
| 15 | archived thread inspection | ❌ |
| 16 | worktree blocked restart | ❌ |
| 17 | worktree forced restart + reconnect or error | ❌ |
| 18 | worktree follow-up after restart failure | ❌ |

**7 of 18 items covered.** The restart/recovery, stop-then-followup, archive, and promote/demote flows were skipped entirely.

### Why agents skip items

1. **The prompt said "sections 1-6"** but the restart matrix is section 6 (embedded in sections 4-5 as sub-items), so agents reasonably interpret the numbered sections differently.
2. **Context/time pressure**: Each restart scenario requires daemon relaunch, waiting for liveness deadlines, and careful state inspection. A single agent can only fit ~5 real-provider thread interactions before hitting time limits.
3. **No explicit tier names**: The runbook doesn't name "this is the light pass" vs "this is the full pass."

### Proposed QA tiers

Add to `qa/daemon/standalone-daemon-qa.md`:

**Light QA pass** (~5 min per provider, automatable):
- daemon health
- local start + follow-up + steer
- worktree start + follow-up
- provider verification (providerId in events)

This is what agents naturally do when asked for a "QA pass." It catches bridge wiring, event translation, and basic turn lifecycle bugs. Use: *"Run a light QA pass for all providers."*

**Extended QA pass** (~15 min per provider):
- Everything in Tier 1, plus:
- local stop then follow-up
- worktree stop then follow-up
- worktree promote/demote
- worktree archive/unarchive + follow-up after unarchive
- two immediate follow-ups in a row (both local and worktree)

This catches session cleanup races, archive state bugs, and promote/demote correctness. Use: *"Run an extended QA pass for Codex."*

**Full QA pass** (~30 min, single provider + fake recovery):
- Everything in Tier 2, plus:
- local blocked restart + forced restart
- worktree blocked restart + forced restart
- surviving env-agent reconnect
- missing env-agent → error transition
- follow-up after restart failure
- provisioning-boundary restart
- queued follow-up during worker loss
- late old-agent noise rejection

Most of the restart/recovery items are already covered by `pnpm qa:daemon:recovery:fake` (8 tests). The manual version adds real-provider restart behavior which the fake suite can't exercise. Use: *"Run a full QA pass."*

### Critical flows that should always be QA'd

These are the flows where bugs are most expensive:

1. **Thread lifecycle** (spawn → active → idle): The happy path. If this breaks, nothing works.
2. **Follow-up after idle**: Session reuse/recreation. Historical source of `agent_shutdown` races.
3. **Steer during active turn**: Mid-turn interruption. Subtle bridge timing issues.
4. **Stop then follow-up**: Session cleanup + restart. Source of "no active session" bugs.
5. **Worktree provisioning**: Git worktree creation, branch setup. Filesystem-dependent.
6. **Archive/unarchive**: Worktree cleanup + resurrection. State leaks if sessions aren't properly closed.
7. **Restart recovery**: Worker loss detection, liveness deadlines, session replacement. The most complex flow.
8. **Multi-thread shared environment**: Session ownership across siblings. Catches env-agent routing bugs.
9. **Dynamic tool round-trip**: Tool registration, forwarding, result delivery. Catches bridge protocol bugs.
10. **Provider event projection**: Events → UI timeline. Catches "invisible tool activity" regressions.

### Recommendation

When asking agents to QA:
- **"Run a light QA pass for all providers"** — catches wiring bugs, ~5 min/provider
- **"Run an extended QA pass for Codex"** — catches state/lifecycle bugs, ~15 min
- **"Run a full QA pass"** — restart/recovery, run once before shipping big changes, ~30 min
- **"Run scripted QA suites"** — `pnpm qa:daemon:smoke` + `smoke:claude-code` + `smoke:pi` + `recovery:fake`
