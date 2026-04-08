# Cloud Sandbox Lifecycle, Auth, And Runtime Material Plan

## Goal

Make ephemeral sandbox hosts safe and durable enough for real thread reuse by fixing lifecycle management, transporting the right runtime material into cloud sandboxes, and exposing the necessary controls in app and project settings.

## Plan Status

- Overall status: active
- Milestone 1 status: planned
- Milestone 2 status: planned
- Retention rule: keep this file after Milestone 1 lands because Milestone 2 remains open; when Milestone 1 ships, update this file to mark Milestone 1 complete instead of deleting it. Delete the plan only after Milestone 2 is complete or the plan is superseded.

## Current Findings

### 1. Lifecycle support exists, but the server does not use it

- `packages/sandbox-host/src/lifecycle.ts` already exposes `suspend()`, `resume()`, and `extendTimeout()`.
- `packages/sandbox-host/src/provision.ts` already provisions E2B sandboxes with `lifecycle: { onTimeout: "pause" }`.
- The server currently never calls `suspend()` or `extendTimeout()` in response to thread idleness or runtime activity.
- `apps/server/src/services/lib/entity-lookup.ts` only derives host status as `connected` or `disconnected`, even though `packages/domain/src/host.ts` already includes `suspended`.

### 2. Activity ingress points are clear

These are the server-owned points where real host activity arrives and where timeout extension can be driven:

- `apps/server/src/internal/events.ts`
- `apps/server/src/internal/commands.ts`
- `apps/server/src/internal/command-result-route.ts`
- `apps/server/src/internal/tool-calls.ts`

Heartbeats in `apps/server/src/ws/daemon-protocol.ts` should not count as activity. They prove connectivity, not useful work.

### 3. Resume is not part of the normal ephemeral-host command path

- Thread start and turn dispatch currently require an already-connected host session via `requireConnectedHostSession(...)`.
- There is no general `ensure sandbox host session` path that resumes a paused sandbox and waits for the daemon to reconnect before queueing work.
- Suspending sandboxes before fixing resume would strand idle threads.

### 4. Runtime material is server-wide only today

- `apps/server/src/services/hosts/sandbox-daemon-env.ts` only injects server-level `GITHUB_TOKEN`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`.
- There is no per-user or per-project secret store.
- There is no UI for sandbox env vars or cloud auth connections in the current app/project settings views.

### 5. Pi/Codex/Claude auth needs server ownership

- `packages/agent-runtime/src/pi/bridge/sdk-session.ts` explicitly notes that Pi built-in tools inherit from `process.env`; Pi does not support per-session env overrides cleanly.
- That means cloud auth cannot be a browser-only concern. It has to be synchronized into the daemon/runtime model on the server side.

### 6. Live E2B validation

I ran the existing suites:

- `pnpm exec turbo run test --filter=@bb/sandbox-host`
- `pnpm exec turbo run test --filter=@bb/server`

Both passed.

I also ran the live smoke flow against real E2B credentials from the primary checkout `.env`.

The smoke now passes on the real isolated-server path:

- sandbox create
- bb daemon bootstrap
- file I/O and command execution
- bundled CLI availability
- sandbox pause/resume
- sandbox-to-server connectivity

I also verified two copies in parallel, each with its own local server port and Cloudflare tunnel URL.

Remaining QA gap: the smoke does not yet validate runtime material sync or cloud auth file materialization.

## External Research

### Terragon patterns worth copying

- Debounced keepalive and timeout extension on real sandbox activity.
- Server endpoint that returns runtime env vars for sandbox reconnect/terminal use.
- Provider-specific auth file generation for Codex and Claude.
- Refresh tokens are intentionally stripped before writing auth files into the sandbox.

### pi-mono patterns worth copying

- OAuth refresh is centralized in server/storage code, not delegated to the runtime.
- Refresh uses locked storage to avoid concurrent refresh corruption.
- Callers receive refreshed credentials and persist them explicitly.

## Recommended Architecture

## AGENTS.md Verification

This plan has been checked against `AGENTS.md` and the implementation should preserve these constraints:

- Async lifecycle ownership: Milestone 1 uses server-owned lifecycle modules for ephemeral sandbox transitions and runtime material sync. It must not overload `hosts.status` with queue/progress meaning.
- Contracts and boundaries: new internal command contracts should use explicit required fields. Defaults belong at the server boundary; the daemon receives fully resolved commands.
- Server and daemon ownership: the server decides lifecycle policy, desired runtime material, merge order, and gating; the daemon only applies host-local state, writes files, and reports results.
- Reuse discipline: existing environment/thread lifecycle patterns should be reused where they fit instead of hand-rolling ad hoc retry or reconciliation code in routes.
- Validation: merge gates use Turbo `build`, `typecheck`, `test`, and `bundle` tasks plus live isolated E2B smoke coverage.

## Milestones

### Milestone 1: Lifecycle And Runtime Material Sync Plumbing

Scope:

- Phase 1: sandbox lifecycle ownership
- Phase 2: extend-on-activity and idle suspension
- Phase 3: automatic resume before queueing work
- Phase 4A: runtime material sync plumbing and migration of existing server-owned runtime material onto that path
- Phase 7A: isolated live E2B QA for lifecycle plus runtime material sync

Explicitly in scope for Milestone 1:

- `sandbox-lifecycle` owning ephemeral sandbox host provision/resume/suspend/extend/destroy
- `host.sync_runtime_material` end-to-end plumbing
- daemon-side application of synced runtime env and version tracking
- use of runtime material sync for the existing server-scoped material we already support today
- lifecycle-safe ordering so thread and environment work waits for runtime sync when required
- recovery semantics for reconnects, expired commands, repeated requests, and lost daemon results

Milestone 1 merge bar:

- no direct sandbox backend calls remain in thread/environment workflow code for ephemeral-host provision/resume/destroy paths
- no runtime secrets remain coupled to bootstrap env for cloud sandboxes
- runtime sync is durable and idempotent across reconnects
- validation is strong enough that Milestone 1 can merge to `main` without Milestone 2

Explicitly out of scope for Milestone 1:

- user-specific or project-specific sandbox env vars
- encrypted storage for user/project runtime material
- provider OAuth/subscription credential sync
- provider auth file generation for Codex or Claude
- settings UI for cloud auth or sandbox env vars

### Milestone 2: User-Specific Runtime Material And Auth

Scope:

- Phase 4B: user/project runtime material and provider auth logic
- Phase 5: encrypted secret storage
- Phase 6: settings UI
- Phase 7B: auth-specific live QA coverage

## Phase 1: Fix Lifecycle Ownership First

Create a dedicated server-owned sandbox lifecycle service:

- File: `apps/server/src/services/hosts/sandbox-lifecycle.ts`

Responsibilities:

- `provisionSandboxHost({ hostId, hostName, provider, serverUrl })`
- `markSandboxActivity({ hostId, source, at })`
- `extendSandboxLifeIfNeeded({ hostId })`
- `ensureSandboxHostSession({ hostId })`
- `ensureRuntimeMaterialSynced({ hostId })`
- `maybeSuspendIdleSandbox({ hostId })`
- `destroySandboxHost({ hostId })`
- `destroySandboxHostIfReady({ hostId })`

This service should be the only owner of ephemeral sandbox host transitions against the provider boundary:

- provision
- resume
- suspend
- timeout extension
- destroy

Thread, environment, and cleanup services should still own product workflow policy:

- deciding when a new sandbox host is needed
- creating thread and environment records
- deciding when a host is eligible for cleanup

Those callers should delegate into `sandbox-lifecycle` instead of calling sandbox backends directly.

Expected call-site changes:

- `thread-create` should call `provisionSandboxHost(...)` instead of invoking `sandboxBackend.provisionHost(...)` and `waitForHostSession(...)` itself
- cleanup/result handlers should call `destroySandboxHostIfReady(...)`
- existing helpers in `host-lifecycle.ts` should either move into `sandbox-lifecycle.ts` or become thin wrappers over it

Concurrency and idempotency requirements:

- repeated `ensureSandboxHostSession(...)` calls for the same host should collapse onto one in-flight resume/wait path
- repeated provision and destroy requests should be deduplicated per host ID
- session-open reconciliation should clear `suspendedAt` for hosts that reconnect successfully
- destroy must remain safe for already-destroyed hosts and hosts with no external sandbox ID

### Data model

Persist explicit ephemeral-host lifecycle state instead of inferring everything from websocket connectivity.

Recommended fields:

- `hosts.lastActivityAt`
- `hosts.suspendedAt`

Optional if needed during implementation:

- a dedicated `sandbox_host_lifecycles` table instead of new `hosts` columns, if that keeps lifecycle ownership cleaner

Rules:

- `lastActivityAt` is updated only by the lifecycle owner.
- `suspendedAt` means the current host state is suspended.
- `destroyedAt` remains the teardown state.

### Host status derivation

Update host status derivation so ephemeral hosts surface:

- `connected` when an active daemon session exists
- `suspended` when `suspendedAt` is set and no active session exists
- `disconnected` otherwise

Milestone 1 should not add queue-state values to host status. Runtime sync and suspend intent/progress must be tracked explicitly in lifecycle state, not inferred from `status`.

## Phase 2: Extend On Real Activity, Then Suspend On Idle

### Extend sandbox timeout on activity

Hook `markSandboxActivity()` into:

- `/internal/session/events` after event batch validation
- `/internal/session/command-result`
- `/internal/session/tool-call`
- `/internal/session/commands` when a non-empty command batch is returned

Do not extend on:

- websocket heartbeats
- empty long-poll responses

Implementation detail:

- debounce by host ID in-memory so a high-volume event stream does not call E2B on every event
- use a fixed horizon extension model, not additive drift

### Idle suspension

Add a periodic idle sweep:

- wire into `apps/server/src/services/system/periodic-sweeps.ts`

Suspend only when all of the following are true:

- host is ephemeral
- host is not destroyed
- host has an external sandbox ID
- host has no active daemon session work in flight that must complete first
- no thread on the host is `active` or `provisioning`
- no pending/fetched command remains for the host
- host has been inactive longer than the configured idle threshold

Add backend support:

- extend `SandboxBackend` with `suspendHost(...)`
- keep `provisionHost(...)`, `resumeHost(...)`, and `destroyHost(...)` behind `SandboxBackend`, but route all server callers through `sandbox-lifecycle`
- for E2B, support both cached and uncached suspend paths

## Phase 3: Make Resume Automatic Before Queueing Work

Replace direct `requireConnectedHostSession(...)` use on ephemeral-host work paths with `ensureSandboxHostSession(...)`.

Paths to update:

- thread start lifecycle
- turn run / steer queueing
- environment provisioning
- command wait helpers that target ephemeral hosts

Concrete call sites to replace or wrap:

- `apps/server/src/services/threads/thread-create.ts`
- `apps/server/src/services/threads/thread-lifecycle.ts`
- `apps/server/src/services/environments/environment-provisioning.ts`
- `apps/server/src/services/hosts/command-wait.ts`
- `apps/server/src/services/threads/thread-storage.ts`
- `apps/server/src/services/threads/thread-commands.ts`

Behavior:

- persistent hosts keep current behavior
- ephemeral hosts resume the sandbox if needed, wait for the daemon session, ensure runtime material is synced, then queue work

This must land before idle suspension is enabled by default.

## Phase 4A: Introduce Runtime Material Sync Plumbing And Existing Material

Separate two concerns:

- sandbox bootstrap material required to start the bb daemon
- provider/runtime material required for actual coding work

### Bootstrap material

Keep bootstrap minimal:

- host enroll key or persisted bb `auth.json`
- bb server URL
- bb host identity

Do not overload bootstrap env with every secret needed for user work.

### Runtime material

Create a new server-owned runtime material service:

- file: `apps/server/src/services/hosts/sandbox-runtime-material.ts`

For Milestone 1, it should first build a typed bundle containing:

- merged env vars
- metadata/version for change detection

Milestone 1 outputs:

- environment variables for provider processes and shell tools

Milestone 1 should move the existing server-owned runtime material onto this path:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

That means the same material currently injected through `sandbox-daemon-env.ts` for cloud sandboxes should instead be delivered through `host.sync_runtime_material`, so bootstrap stays minimal and runtime state becomes refreshable/replayable after reconnect.

Milestone 1 should not introduce user/project-specific env vars or provider auth files yet.

### Command contract

Add a dedicated daemon command for Milestone 1:

- `type: "host.sync_runtime_material"`

Milestone 1 command payload should be authoritative, not patch-based. The server should send the full managed runtime material snapshot for the host, and the daemon should replace its managed runtime material state with that exact snapshot.

Recommended required fields:

- `version`: deterministic content-hash or equivalent stable version string
- `env`: full authoritative map of managed runtime environment variables
- `files`: required array for future expansion; Milestone 1 sends an empty array

Milestone 1 result payload should at least return:

- `appliedVersion`

This keeps the Milestone 1 contract compatible with Milestone 2 without introducing accepted-but-ignored fields.

### Durable sync state and reconciliation

Milestone 1 must define explicit durable runtime-sync state instead of inferring progress from websocket connectivity or host status.

Recommended approach:

- add a host-scoped lifecycle record for runtime sync, similar to existing environment/thread operation records
- if a new table is cleaner, prefer a dedicated host operation table over overloading `hosts`

Minimum state to persist:

- desired runtime material version
- last successfully applied runtime material version
- last successful sync time
- last sync failure reason, if any
- queued command ID when a sync command is in flight

Lifecycle rules:

- repeated sync requests collapse to the latest desired version
- if the desired version already matches the applied version, no command is queued
- if a sync command expires or the daemon disconnects before reporting success, the lifecycle owner requeues it on the next advance/reconcile pass
- session open should reconcile desired vs applied version and requeue sync when needed
- new work should wait on `ensureRuntimeMaterialSynced(...)` only for the specific host being targeted

### Daemon application model

Milestone 1 daemon work should reuse the existing runtime shell env path rather than introduce a parallel environment source.

Required daemon behavior:

- add a handler for `host.sync_runtime_material` in `apps/host-daemon/src/command-dispatch.ts`
- update daemon-owned managed runtime env state atomically from the authoritative snapshot
- make that managed env available to future runtime creation and host-local shell tooling
- persist the applied runtime material snapshot and version under `BB_DATA_DIR` with `0600` permissions so smoke tests and debugging can verify what was applied

Milestone 1 does not need to live-mutate already-running provider child-process environments. Instead:

- sync must complete before new thread/environment work is queued
- if the daemon is holding idle cached runtimes, it should evict or recreate them after a version change so resumed work picks up the synced env
- active in-flight work should not be interrupted solely to refresh Milestone 1 runtime material

### Bootstrap cleanup

Milestone 1 should narrow the bootstrap env path so it only carries daemon/bootstrap material:

- `BB_HOST_ENROLL_KEY`
- `BB_SERVER_URL`
- bb host identity and daemon bootstrap paths

The current server-scoped runtime secrets should stop flowing through `sandbox-daemon-env.ts` for cloud sandboxes once runtime sync is in place.

### Delivery model

Recommended flow:

1. Provision/resume sandbox with bb bootstrap only.
2. Daemon reconnects.
3. Server queues a new host command: `host.sync_runtime_material`.
4. Daemon writes files with `0600`, updates its cached runtime env, and acknowledges the applied version.
5. Thread/environment work starts only after sync completes.

This aligns with current ownership boundaries:

- server decides what material is allowed
- daemon performs host-local file/env writes

## Phase 4B: Add User-Specific Runtime Material And Auth Logic

Extend the runtime material service to build the full typed bundle containing:

- merged env vars
- provider auth files to write
- metadata/version for change detection

Recommended first-class outputs:

- environment variables for provider processes and shell tools
- `~/.codex/auth.json`
- `~/.claude/.credentials.json`

For providers that use raw API keys, inject env vars only.

For providers that use OAuth/subscription credentials, refresh on the server and write sandbox files without refresh tokens.

### Non-negotiable auth rule

The sandbox must never receive a refresh-capable credential.

Examples:

- Codex auth file must have `refresh_token: ""`
- Claude credentials file must have `refreshToken: ""`
- `last_refresh` / equivalent metadata should be written so the CLI does not immediately try to refresh

## Phase 5: Add Encrypted Secret Storage

Add explicit encrypted storage for cloud-sandbox runtime material.

Recommended scopes:

- app/global sandbox env vars
- project sandbox env vars
- user auth/subscription connections
- project-to-credential bindings when the user has multiple connections for one provider

Suggested tables:

- `user_sandbox_env_vars`
- `project_sandbox_env_vars`
- `user_provider_credentials`
- `project_sandbox_provider_bindings`

Security requirements:

- encrypt values at rest
- never return plaintext secret values after creation except when explicitly editing
- return masked values plus metadata for the UI
- redact secret-bearing fields from logs and errors

Merge order:

1. server-required runtime vars
2. app/global user vars
3. project vars
4. provider-specific runtime material

Project scope wins on key collision.

## Phase 6: Add Settings UI

Only show these surfaces when `sandboxHostSupported` is true.

### App settings

Add sections to `apps/app/src/views/AppSettingsView.tsx`:

- `Cloud Auth`
- `Global Sandbox Env Vars`

`Cloud Auth` should support:

- Codex/OpenAI connection
- Claude/Anthropic connection
- any initial API-key-only providers we decide to support

### Project settings

Add sections to `apps/app/src/views/ProjectSettingsView.tsx`:

- `Sandbox Env Vars`
- `Cloud Credential Exposure` if multiple provider connections must be selectable per project

The project page should let the user:

- add/edit/remove project-scoped env vars
- select which saved provider connection is exposed to the project, if more than one exists

## Phase 7A: Expand Isolated Live E2B QA For Milestone 1

Keep `scripts/qa/e2b-smoke.mts` on the isolated real-server path and extend it rather than reintroducing a fake server.

Then extend it to cover:

1. sandbox create
2. bb daemon bootstrap
3. runtime material sync
4. use of runtime material sync for existing server-owned env material
5. pause on idle
6. resume on follow-up work
7. timeout extension during active event flow

Milestone 1 smoke should verify more than command success:

- the daemon acknowledges the expected runtime material version
- the applied runtime material snapshot on disk contains the expected server-scoped keys
- bootstrap-only env is sufficient for daemon startup before runtime sync runs
- two concurrent smoke runs do not share server state, tunnel URLs, or lifecycle rows

## Phase 7B: Expand Live QA For Auth Material

Add coverage for:

1. provider auth file generation with refresh tokens stripped
2. user/project env merge behavior
3. reconnect re-sync of auth/runtime material after sandbox resume

## Rollout Strategy

Ship behind feature flags/config switches:

- `sandboxRuntimeMaterialEnabled`
- `sandboxIdleSuspendEnabled`

Recommended order:

1. lifecycle service + extend-on-activity
2. automatic resume path plus sandbox-lifecycle-owned provision/destroy entrypoints
3. runtime material sync plumbing plus migration of existing server-owned material
4. idle suspension default-on
5. user/project secret storage plus auth material builders
6. settings UI

Milestone 1 should merge only after steps 1 through 4 are complete and validated. Milestone 2 should build on the shipped Milestone 1 path instead of reworking it.

## Milestone 1 Exit Criteria

- Ephemeral sandbox host provision/resume/suspend/destroy flows are owned by `sandbox-lifecycle`.
- Ephemeral hosts can resume automatically before thread start and turn dispatch.
- Idle ephemeral hosts suspend after the configured threshold.
- Active sandboxes have their timeout extended on real work activity.
- Host APIs and UI can represent `suspended`.
- Runtime material sync exists as a first-class server-to-daemon path.
- Existing server-scoped runtime material is delivered through runtime material sync instead of bootstrap env coupling.
- Thread and environment work can wait for runtime material sync when needed.
- Runtime sync recovers correctly from reconnects, expired commands, and repeated requests.
- No bootstrap-only path is still relied on for `GITHUB_TOKEN`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` in cloud sandboxes.
- The isolated live E2B smoke test passes end to end, including runtime material sync and parallel-run validation.

## Milestone 1 Merge Checklist

- `sandbox-lifecycle` owns ephemeral sandbox provider transitions and runtime-sync gating.
- `host.sync_runtime_material` is implemented in contract, server, and daemon.
- runtime sync uses explicit durable lifecycle state and does not overload host status.
- existing server-scoped runtime material is removed from bootstrap coupling for cloud sandboxes.
- idle suspend is enabled only after automatic resume and runtime sync gating are in place.
- build, typecheck, test, bundle, and isolated live smoke verification all pass.

## Milestone 2 Exit Criteria

- App settings supports cloud auth connections and global sandbox env vars when sandbox hosts are supported.
- Project settings supports project sandbox env vars and project credential binding/exposure when sandbox hosts are supported.
- Codex and Claude cloud auth files are generated without refresh tokens.
- Runtime material is refreshed only by the server.
- User/project runtime material is stored encrypted at rest.
- Live QA covers auth file generation and user/project runtime material merge behavior.

## Validation

### Unit and integration

Run:

- `pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/host-daemon-contract --filter=@bb/sandbox-host`
- `pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/host-daemon-contract --filter=@bb/sandbox-host`
- `pnpm exec turbo run test --filter=@bb/sandbox-host`
- `pnpm exec turbo run test --filter=@bb/host-daemon-contract`
- `pnpm exec turbo run test --filter=@bb/host-daemon`
- `pnpm exec turbo run test --filter=@bb/server`

Add coverage for:

- lifecycle state transitions
- activity debounce and timeout extension
- idle suspension eligibility
- resume-before-queue behavior
- host status derivation including `suspended`
- runtime material sync command success/failure handling
- use of runtime material sync for existing server-scoped env material
- runtime sync reconciliation after reconnect and expired command handling
- runtime sync deduplication when multiple callers request sync for the same host

For Milestone 2, also add:

- env var merge order
- runtime material builders stripping refresh tokens
- user/project credential binding and auth-file generation behavior

### Live E2B For Milestone 1

Using the isolated real-server smoke script:

1. Source the primary checkout `.env`.
2. Build daemon bundles:
   - `pnpm exec turbo run bundle --filter=@bb/host-daemon`
3. Run the smoke flow from `packages/sandbox-host` so `tsx` resolves:
   - `set -a; source /Users/michael/Projects/bb/.env; set +a; pnpm exec tsx ../../scripts/qa/e2b-smoke.mts > /tmp/bb-e2b-smoke.log 2>&1`
4. Verify the log contains successful create, daemon bootstrap, runtime sync, pause, resume, and destroy steps.
5. Inspect the sandbox-applied runtime material snapshot and verify it contains the expected Milestone 1 keys and version.
6. Run two copies in parallel and verify both pass with distinct local server ports and distinct public tunnel URLs.

### Manual API / State Checks For Milestone 1

Use direct server state inspection to confirm lifecycle behavior:

1. Query the dev database and verify `hosts.suspendedAt` is set after idle suspension and cleared after resume.
2. Query the relevant host runtime-sync lifecycle state and verify desired/applied versions match after successful sync.
3. Confirm no pending/fetched runtime-sync command remains for the host after success.
4. Confirm a resumed host can accept new thread/environment work without relying on a fresh bootstrap env injection.

### Live E2B For Milestone 2

Using the same isolated real-server harness:

1. Seed test credentials and user/project runtime material.
2. Run the smoke flow.
3. Verify auth files are materialized without refresh tokens.
4. Verify user/project env merge behavior and reconnect re-sync after pause/resume.

## Notes For Implementation

- Do not thread lifecycle state through ad hoc route helpers. Keep ephemeral sandbox host transitions in a dedicated server-owned lifecycle module.
- Do not let the sandbox mutate durable auth state.
- Do not rely on daemon heartbeats as proof of useful activity.
- Do not enable suspend-by-idle until automatic resume is in place.
- Keep this plan file after Milestone 1 lands and update the status section to mark Milestone 1 complete; Milestone 2 remains the reason the file stays in the repo.
