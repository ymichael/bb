# Provider-Agnostic Pending Interactions

## Goal

Add a provider-agnostic interaction system that lets an agent pause and wait for
the user to:

- approve or deny a command
- approve or deny a file change
- grant additional permissions
- answer one or more structured questions
- respond to MCP elicitation requests

The first shipped integration should use this generic system through the Codex
adapter. Claude and any future provider should plug into the same lifecycle
rather than introducing provider-specific product surfaces. The first shipped
operator surface should be the CLI so the backend lifecycle can be exercised in
a closed loop before any app UI work lands.

## Why This Matters

Today bb behaves as if interactive approvals do not exist:

- Codex is started with `approvalPolicy: "never"` in
  [packages/agent-runtime/src/codex/adapter.ts](/Users/michael/.codex/worktrees/250d/bb/packages/agent-runtime/src/codex/adapter.ts)
- Claude Code is started with permission bypass in
  [packages/agent-runtime/src/claude-code/bridge/sdk-session.ts](/Users/michael/.codex/worktrees/250d/bb/packages/agent-runtime/src/claude-code/bridge/sdk-session.ts)
- provider JSON-RPC requests are only routed if they decode as dynamic tool
  calls in
  [packages/agent-runtime/src/runtime.ts](/Users/michael/.codex/worktrees/250d/bb/packages/agent-runtime/src/runtime.ts)
- daemon and server transport only expose a tool-call path today in
  [apps/host-daemon/src/server-client.ts](/Users/michael/.codex/worktrees/250d/bb/apps/host-daemon/src/server-client.ts)
  and
  [apps/server/src/internal/tool-calls.ts](/Users/michael/.codex/worktrees/250d/bb/apps/server/src/internal/tool-calls.ts)
- the public app has no route or UI for resolving blocked interactions in
  [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/250d/bb/apps/server/src/routes/threads/actions.ts)

As a result, the product effectively only supports full access or
failure/bypass. Worse, non-tool provider requests can currently be dropped
without any JSON-RPC response, which can leave the provider hanging while it
waits for a reply.

## Product Shape

### Initial vertical slice

Ship the smallest end-to-end flow that proves the generic lifecycle against a
real provider:

- root thread only
- CLI resolver only
- exactly one active pending interaction per thread
- Codex only
- command approval only
- approvals granted through this flow are session-scoped only
- resolution happens through `bb thread interactions` commands rather than app
  UI
- while a thread has a pending interaction, `send` and `turn/steer` style
  follow-up requests are rejected with `409 awaiting_user_interaction`
- unsupported or concurrent provider interaction requests receive an explicit
  provider-facing rejection or cancel; they must never be dropped or left
  unanswered

This slice is intentionally narrow so the generic lifecycle is proven before bb
expands to more interaction kinds or frontend surfaces.

### Expanded CLI scope

After the vertical slice works end to end, expand the same lifecycle and CLI
surface to:

- Codex ask-user-question
- Codex file-change approval

### Later backend scope

- permission scopes and grant persistence semantics
- MCP elicitation forms and URLs
- headless and deferred resolution flows
- Claude parity on top of the same internal lifecycle

### Final app scope

- app query hooks and mutations on top of the same server contract
- first-class app UI for all supported interaction kinds
- app badge or inbox views backed by the same paginated interaction queries

## Design Principles

- The lifecycle must be provider-agnostic.
- The server owns the durable interaction lifecycle and policy.
- The daemon owns transport of blocked provider requests and provider response
  submission.
- Providers only translate between provider-native payloads and bb's internal
  interaction contract.
- Backend and CLI should form the first closed loop. App UI is a later consumer
  of the same contract, not a prerequisite for proving it.
- Phase 1 supports exactly one active pending interaction per thread. Queueing
  multiple interactions is a later enhancement.
- Every provider request must receive an explicit resolution or an explicit
  provider-facing rejection. No provider request may be dropped silently.
- Do not encode this lifecycle in `thread.status` or other unrelated resource
  state.
- Do not fake this as ordinary timeline text. It needs first-class state,
  routing, and resolution APIs.
- Authorization for listing and resolving interactions must match authorization
  for the owning thread.
- Any global or cross-thread pending-interaction query must be paginated and
  bounded.
- Root-thread-only support is acceptable for the first ship if it is enforced
  explicitly and documented.

## Proposed Internal Model

Introduce a new server-owned lifecycle module and shared contract centered on a
generic `PendingInteraction`.

### Shared interaction shape

Add domain types for:

- `PendingInteraction`
- `PendingInteractionKind`
- `PendingInteractionStatus`
- `PendingInteractionPayload`
- `PendingInteractionResolution`

`PendingInteractionKind` should be a discriminated union with these values:

- `command_approval`
- `file_change_approval`
- `permission_request`
- `user_input_request`
- `mcp_elicitation`

Each interaction should carry:

- stable interaction id
- thread id
- optional turn id
- provider id
- provider request id or callback id
- created-at and resolved-at timestamps
- kind-specific payload
- explicit status owned by the interaction lifecycle

This lifecycle should be separate from thread status and turn status.

`PendingInteractionStatus` should be an explicit lifecycle state owned by the
server module:

- `pending`
- `resolved`
- `rejected`
- `interrupted`
- `expired`

### Persistence

Add a durable store for pending interactions and their resolutions.

Minimum requirements:

- one row per interaction
- durable raw provider correlation identifiers
- durable normalized payload
- durable resolution payload
- ability to query pending interactions by thread id
- bounded global query support for app badges or inbox UI with cursor pagination
  and a server-side page-size cap of 100
- an invariant of at most one active `pending` interaction per thread in phase 1

### Recovery Semantics

These semantics must be designed before implementation starts, even if later
phases improve them:

- app refresh:
  - pending interactions remain queryable and resolvable from persisted state
- duplicate request creation:
  - duplicate create attempts for the same provider callback identity resolve to
    the existing pending interaction instead of creating a second row
- duplicate resolution:
  - resolution is idempotent and first terminal resolution wins
- daemon restart or provider-process exit in phase 1:
  - the pending interaction transitions to `interrupted`
  - the blocked provider request is not resumed automatically
  - the user must retry the turn manually
- expired interactions:
  - unresolved interactions can be marked `expired` by the lifecycle module
  - expiry produces an explicit user-visible reason rather than silently
    disappearing
- lost daemon results or reconnect:
  - reconciliation is defined by the lifecycle module rather than ad hoc in
    transport code
- concurrent interactions in phase 1:
  - one active pending interaction per thread
  - additional interaction requests from the same thread receive an explicit
    provider-facing rejection or cancel

### Eventing

Keep the timeline readable, but do not rely on timeline rows as the source of
truth.

Recommended:

- add provider or system events for interaction requested and interaction
  resolved
- keep the persisted interaction record as the canonical state
- render timeline summaries from that canonical state

## Work Plan

### Phase 0: Define the generic contract

1. Add shared domain types for pending interactions and resolutions.
2. Commit the phase 1 lifecycle semantics in the plan and contracts:
   - Codex command approval only
   - one active pending interaction per thread
   - `send` and `turn/steer` requests return `409 awaiting_user_interaction`
   - unsupported or concurrent provider requests receive an explicit
     provider-facing rejection or cancel
   - approvals granted through this flow are session-scoped only
   - list and resolve authorization matches the owning thread
   - daemon restart or provider-process exit marks the interaction
     `interrupted`
3. Add server and daemon contract types for:
   - reporting a provider request that needs user interaction
   - listing pending interactions
   - resolving an interaction
   - cancelling or expiring an interaction if needed
4. Define dedupe and idempotency keys for create and resolve operations.
5. Define the phase 1 runtime callback name and contract:
   - `onInteractiveRequest`

Exit condition:

- a provider-agnostic type contract exists in shared packages
- the contract does not mention Codex or Claude in its public names
- the lifecycle semantics for reconnect, duplicate requests, expiry, provider
  exit, and `turn/steer` while pending are written down before implementation

### Phase 1: Fix the runtime transport boundary

1. Extend `@bb/agent-runtime` so provider JSON-RPC requests are not treated as
   "tool call or drop".
2. Add a provider request decoding layer for:
   - dynamic tool calls
   - interactive requests
3. Add a runtime callback surface parallel to `onToolCall`:
   - `onInteractiveRequest`
4. Keep provider request-response correlation explicit and typed.
5. Preserve current dynamic tool behavior.
6. For unsupported provider request kinds, return an explicit JSON-RPC error or
   provider-facing rejection rather than dropping the request.

Exit condition:

- the runtime can receive a provider request that is not `item/tool/call`
- unsupported requests are answered explicitly rather than hanging the provider

### Phase 2: Build the server-owned lifecycle module and internal plumbing

1. Introduce a dedicated server lifecycle module for pending interactions.
2. Centralize:
   - creation
   - lookup
   - resolution
   - cancellation
   - expiry
   - audit logging
   - phase 1 policy enforcement
3. Add persistence for pending interactions and their resolutions.
4. Add a new internal daemon-to-server route family for interactive requests and
   resolutions, implemented on top of the lifecycle module.
5. The daemon should:
   - send normalized interactive requests to the server
   - block the provider request until the server returns a resolution
6. The server should:
   - validate and persist the interaction through the lifecycle module
   - accept a later resolution and reply to the daemon
7. Make create and resolve operations idempotent.

Exit condition:

- a provider request can pause in the daemon, persist on the server, and later
  resume with a typed resolution
- interaction lifecycle rules live in one server-owned module
- thread and turn state do not own this lifecycle

### Phase 3: Ship the Codex command-approval CLI vertical slice

1. Stop hardcoding `approvalPolicy: "never"` for the Codex path needed by the
   command-approval slice.
2. Map Codex command-approval requests into `PendingInteraction`.
3. Add thread-scoped server routes for:
   - list pending interactions
   - get a pending interaction
   - resolve a pending interaction
4. Ensure those routes enforce the same authorization boundary as the owning
   thread.
5. Add a `bb thread interactions` CLI command group with subcommands for:
   - list
   - show
   - approve
   - deny
6. Enforce the phase 1 behavior that a thread with a pending interaction
   rejects `send` and `turn/steer` with `409 awaiting_user_interaction`.
7. Add targeted tests for request correlation, duplicate resolve attempts, and
   provider-process exit while a request is pending.

Exit condition:

- a user can resolve a Codex command approval from the CLI and the same blocked
  turn resumes or fails as designed
- the vertical slice is live through the generic pending-interaction lifecycle

### Phase 4: Expand Codex CLI interaction kinds

1. Add Codex ask-user-question support.
2. Add Codex file-change approval support.
3. Extend `bb thread interactions` to render and resolve those typed payloads.
4. Add timeline summaries backed by canonical interaction state.

Exit condition:

- the same lifecycle and CLI surface support at least command approval,
  ask-user-question, and file-change approval for Codex threads

### Phase 5: Add later backend-only kinds and parity

1. Add permission-request support with explicit grant scope handling.
2. Add MCP elicitation support for form and URL payloads.
3. Extend the CLI and server routes to support those payloads.
4. Remove Claude's unconditional permission bypass for supported interaction
   modes.
5. Map Claude approval and question callbacks onto the same generic lifecycle.
6. Add a headless or deferred flow for non-foreground runs:
   - durable pending state
   - explicit "awaiting user input" status visible to clients
   - later resolution from CLI or API
7. Decide how automations and background runs should behave when interaction is
   required.
8. Keep these kinds on the same lifecycle model and authorization boundary.

Exit condition:

- permission requests, MCP elicitation, deferred flows, and Claude use the same
  pending-interaction lifecycle and backend contract

### Phase 6: Add the app surface last

1. Reuse the thread-scoped list, get, and resolve routes from phase 3.
2. Add one bounded global pending-interactions route for app badges or inbox
   views.
3. Add app query hooks and mutations on top of the canonical server contract.
4. Add first-class app UI for command approval, ask-user-question,
   file-change approval, permission requests, and MCP elicitation.
5. Reuse the same lifecycle rules, authorization rules, and dedupe semantics
   already proven through the CLI.

Exit condition:

- the app can display and resolve the same pending interactions already
  supported by the backend and CLI
- app UI does not introduce a second lifecycle or provider-specific product
  path

## Open Questions

1. Should later phases add queued interactions per thread, or keep the invariant
   of one active interaction per thread even after phase 1?
2. Should manager threads ever be allowed to issue `ask-user-question`, or do
   we reserve that for standard threads only?
3. How should automations and other headless runs surface deferred pending
   interactions to users once phase 5 begins?

## Exit Criteria

This plan is complete only when all of the following are true:

- bb has a provider-agnostic pending interaction contract and lifecycle
- Codex uses that lifecycle for the supported first-ship interaction kinds
- the CLI can list and resolve pending interactions through first-class server
  routes and commands
- the app can later display and resolve those same interactions through
  first-class API routes and UI
- the daemon and server correctly recover pending interactions across reconnects
- unsupported interaction kinds fail explicitly and predictably
- Claude can be integrated later without changing the product model or API
  shape

## Validation

### Automated

- `pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/db --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/agent-runtime --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=@bb/app`
- `pnpm exec turbo run test --filter=@bb/domain --filter=@bb/db --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/agent-runtime --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=@bb/app --force`

Add or update tests for:

- runtime forwarding of non-tool provider requests
- daemon-server request persistence and later resolution
- pending interaction lifecycle transitions
- duplicate and stale resolution handling
- reconnect recovery
- provider-process exit while an interaction is pending
- CLI list and resolve flows
- app query and resolve flows
- Codex adapter request and response mapping
- Claude adapter request and response mapping once phase 5 lands

### Manual

Run these scenarios against a local CLI + server + daemon, then repeat the
relevant UI checks once phase 6 lands:

1. Start a Codex-backed thread configured to allow interactive requests.
2. Trigger a command approval request and confirm it appears in
   `bb thread interactions list`.
3. Deny the request through the CLI and verify the provider receives a denial
   and the turn continues or fails as designed.
4. Trigger an ask-user-question request and verify the CLI answer path resumes
   the same turn.
5. Trigger a file-change approval request and verify the CLI can inspect and
   resolve the payload correctly.
6. Trigger a permission request and verify the CLI applies the documented grant
   scope semantics.
7. Trigger an MCP elicitation request and verify the CLI captures the form or
   URL response and resumes the provider correctly.
8. Restart the daemon while a request is pending and verify the lifecycle
   recovers or fails in the documented way.
9. Kill the provider process while a request is pending and verify the
   interaction transitions to `interrupted` with the documented recovery path.
10. Run a deferred or headless flow once phase 5 lands and verify the pending
    interaction remains listable and resolvable without app UI.
11. Once phase 6 lands, refresh the app while a request is pending and verify
    the interaction is still visible and resolvable there as well.
12. Once phase 6 lands, resolve the same kind through the app and confirm the
    server and daemon behavior matches the CLI path.
13. Verify unsupported kinds produce an explicit user-visible explanation
    rather than disappearing.

### Manual Comparison Checklist

- pending interactions are visible without reading raw timeline data
- CLI resolution is sufficient to exercise the lifecycle before app UI lands
- resolutions are correlated to the correct provider request
- the same internal contract can represent both Codex and Claude requests
- no thread status or turn status field is overloaded to represent this
  lifecycle
- root-thread-only restrictions are enforced intentionally, not accidentally
