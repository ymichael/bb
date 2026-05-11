# Agent Asks User Question Plan

## Goal

Let a running thread pause and ask the human user a question, render the
question as a first-class timeline row with answerable controls, and resume the
agent with the user's answer.

The data model — payload schema, resolution shape, persisted event, timeline
row — must be fully provider-agnostic: no field names borrowed from any
provider's tool schema, no provider-specific constraints baked into the
contract, no assumption that a particular provider will be the one emitting it.
The internal primitive is "the agent is asking the user something"; adapters
translate to and from each provider's surface.

Out of scope for v1: any provider other than Claude Code. The data model is
designed for parity but only the Claude Code adapter ships wired up. Codex,
Pi, and any future provider remain on the no-op path until their adapter is
extended. Also out of scope: rich form/wizard inputs beyond multi-choice + free
text, and agents asking other agents (the existing manager `message_user` flow
already covers delegation handoffs).

## Provider Capability Matrix

Findings from upstream docs and issue trackers, captured as design context.
Only Claude Code is in scope to ship; the rest are recorded so the data model
doesn't accidentally exclude them later:

- **Claude Code / Agent SDK**: built-in `AskUserQuestion` tool. Schema is a
  `questions` array (1–4 items), each with `question`, `header` (≤12 chars),
  `options` (2–4 `{label, description}` items), optional `multiSelect`. Routes
  through the same `canUseTool` callback as tool approvals; host returns
  `{ behavior: "allow", updatedInput: { questions, answers } }`. The callback
  may pend indefinitely. `PreToolUse`/`PostToolUse` hooks fire normally. The TS
  SDK exposes a `defer` decision so the host process can exit and resume from
  the persisted session. **Not available inside Agent-tool subagents.**
- **OpenAI Codex CLI**: `request_user_input` / `AskUserQuestion`-style tool
  exists *only in Plan Mode*. In Default Mode the tool is stripped — open
  issues openai/codex#11266, #9926, #11536 confirm this is unresolved upstream.
  Workaround in Default Mode is prompt-engineering the model to print the
  question in plain text.
- **Pi**: unknown until verified. The runtime adapter already implements
  `decodeInteractiveRequest` / `buildInteractiveResponse` for approvals, but
  whether the Pi process emits question-shaped requests is not documented in
  the repo. Treat as "verify, then map or fall back."
- **Other agents (for context only)**: Cline/Roo `ask_followup_question` (one
  question + chips), Continue.dev `AskQuestion`, Cursor 2.4 non-blocking
  clarification — all model this as a tool the host implements. No widespread
  "special turn type" or dedicated event.

**Cross-provider pattern**: every provider that has formalized this models it
as a tool call whose execution blocks until the human answers and returns the
answer as the tool result. We should mirror that internally.

## Current Findings

- The `PendingInteraction` lifecycle (DB table in `packages/db/src/schema.ts`,
  service in `apps/server/src/internal/interactive-requests.ts`,
  `POST /threads/:id/pending-interactions/:id/resolve` endpoint) already
  handles "provider blocks, server stores pending request, user resolves, host
  daemon delivers response". Today it is approval-only: command, file change,
  permission grant.
- `ProviderAdapter` (`packages/agent-runtime/src/provider-adapter.ts`) already
  defines optional `decodeInteractiveRequest()` and `buildInteractiveResponse()`
  hooks. All three adapters (`claude-code/adapter.ts`, `codex/adapter.ts`,
  `pi/adapter.ts`) implement them for approvals.
- `PendingInteractionPayload` in `packages/domain/src/pending-interactions.ts`
  is currently the approval union (`approvalPendingInteractionPayload`).
  `PendingInteractionResolution` is `allow_once | allow_for_session | deny`.
  Both need to extend with a new discriminant for questions/answers.
- `packages/server-contract/src/thread-timeline.ts` has no row type for a
  pending user question. Approvals are surfaced via
  `TimelinePermissionGrantApprovalLifecycleRow` — a good shape to copy.
- `packages/thread-view/src/build-thread-timeline.ts` accumulates events into
  timeline rows. A new projection branch is needed for the question event.
- `message_user` already exists as the manager → user fire-and-forget primitive
  (`apps/server/src/internal/tool-calls.ts`, emits
  `system/manager/user_message`). It is *not* the same thing — that's a
  one-way notification with no response slot — but it confirms the codebase
  pattern of routing user-facing tool calls through the server.
- Manager (`packages/templates/.../manager-agent-instructions.md`) is built for
  async orchestration; standard agents (`standard-agent-instructions.md`) are
  focused, in-turn workers. Asking the user blocks the provider's current turn
  in both cases — the question is whether managers and standard agents both
  *should* have the tool. Current recommendation: both, since the underlying
  mechanism is the same as a long-running tool call.
- Claude Code's `AskUserQuestion` is not available in subagents spawned via the
  Agent tool. Our managed threads are not Agent-tool subagents (they're
  separately-spawned thread processes), so this limit does not transfer — but
  worth verifying when we wire it up.

## Design

### Provider-agnostic primitive

Define a `userQuestion` discriminant on `PendingInteractionPayload` using
field names and constraints chosen for our domain — not borrowed from any
provider:

```
{
  kind: "user_question",
  questions: [
    {
      id: string,                // host-assigned, stable, used as answers map key
      prompt: string,            // the question text
      shortLabel?: string,       // optional concise label for compact UI surfaces
      multiSelect: boolean,
      options?: [{ value: string, label: string, description?: string }],
      allowFreeText: boolean,    // true => free-text answer accepted (alone or alongside options)
    },
    ...
  ],
}
```

Resolution variant:

```
{
  kind: "user_answer",
  answers: Record<questionId, { selected: string[]; freeText?: string }>,
}
```

Notes on agnosticism:

- No upper or lower bound on the number of questions in the contract. Any
  per-provider limits (e.g. Claude's 1–4) are enforced inside the adapter when
  translating, not in the shared schema.
- `shortLabel` has no character cap in the contract. Adapters/UIs may truncate
  for their own surfaces.
- Options use `{ value, label, description }`, where `value` is the canonical
  identifier the host stores in answers and `label` is human-readable. This
  keeps "what the user picked" independent of display strings.
- The answer shape always carries both `selected` and `freeText` slots so a
  question can mix selections and a typed elaboration without schema gymnastics.
- The payload never names a provider, tool, or SDK. Adapters own all
  translation.

### Provider adaptation (v1 = Claude Code only)

Only the Claude Code adapter wires this up at launch. Other adapters keep
their current no-op for the new payload kind, and the provider catalog records
their capability as `userQuestion: "unsupported"`.

- **Claude Code**: the adapter's `decodeInteractiveRequest` recognizes the
  native `AskUserQuestion` tool-call shape and projects it into the host's
  `userQuestion` payload. `buildInteractiveResponse` translates a
  `user_answer` resolution back into Claude's expected response shape.
  Translation is confined to the adapter; the rest of the system never sees
  Claude-specific field names.
- **Codex, Pi, future providers**: out of scope for v1. The capability
  matrix above captures what each provider would need; revisit per-provider
  when prioritized.

Capture per-provider support on the provider catalog entry
(`packages/agent-providers/src/catalog.ts`) so the UI and agent instructions
can degrade gracefully — e.g. don't advertise a question primitive on a
provider whose adapter can't deliver it.

### Tool surface to the agent

Because v1 is Claude-only, no host-injected dynamic tool is needed yet — the
model uses Claude's native `AskUserQuestion` and the adapter intercepts it.
The host-side primitive name (used in event types, timeline rows, API
fields) is provider-neutral (`userQuestion` / `user_answer`) so when a future
adapter does want to inject a dynamic tool (likely for Codex Default Mode or
Pi), the rest of the system needs no changes.

### Timeline event + row

- New `ThreadEventItem` discriminant for `agent_question` carrying the
  questions payload, the `pendingInteractionId`, and an answers slot that gets
  populated on resolution.
- New `TimelineQuestionRow` in `packages/server-contract/src/thread-timeline.ts`
  modeled on `TimelinePermissionGrantApprovalLifecycleRow`:
  states `pending | resolving | answered | interrupted | expired`.
- Projection branch in `build-thread-timeline.ts` that folds the original
  question event and the eventual resolution event into a single row.

### UI

Reuse the approval-row component family. Render each question as a chip-headed
block with option buttons (single- or multi-select) and a free-text field when
`allowFreeText`. On submit, hit the existing
`POST /threads/:id/pending-interactions/:id/resolve` route with the new
resolution variant. While pending, the thread's compose box should indicate
"agent is waiting for an answer above" rather than allowing arbitrary input —
the existing pending-approval UX has the same constraint and can be the model.

### Resolution path

No new endpoint needed. Extend the resolve route handler to accept the new
resolution variant, route it through `pendingInteractions.resolvePendingInteraction`,
and signal the daemon via the existing
`POST /session/interactive-request/interrupt` path. The runtime then calls the
adapter's `buildInteractiveResponse`, which writes JSON-RPC back to the
provider — or, for the dynamic-tool fallback, returns it as the tool result.

## Open Questions

1. **Cancellation**: what happens if the user closes the thread / interrupts
   the turn while a question is pending? Existing approval lifecycle has an
   `interrupted` state — confirm the same wiring fires for the question
   payload.
2. **Defer / long pause**: Claude's `defer` decision lets the host process
   exit and re-spawn when the answer lands. Worth deferring (no pun) to a v2;
   the data model already permits any latency since it sits in the same
   PendingInteraction lifecycle as approvals.
3. **Subagent constraint**: re-verify that managed threads are not subject to
   Claude's "no `AskUserQuestion` in Agent-tool subagents" restriction. If
   they are, manager-spawned threads need a different path (likely a
   host-injected tool) — but that's a Claude-adapter concern, not a
   data-model concern.
4. **Manager-only?**: should standard agents be allowed to ask, or is it
   manager-only? Current recommendation: allow both, because the mechanism is
   identical to a blocking tool call and the cost of restricting is real
   (standard agents can't unblock themselves on ambiguity).
5. **Notification**: when a question lands, do we surface a push/system
   notification? Not required for v1, but the
   `provider-turn-watchdog.md` plan touches similar territory.

## Phases

### Phase 1 — Contract + lifecycle (provider-agnostic)

- Extend `PendingInteractionPayload` and `PendingInteractionResolution` unions
  in `@bb/domain` with the `user_question` / `user_answer` shapes above.
- Add the new `ThreadEventItem` discriminant for an emitted question and its
  resolution.
- Add `TimelineQuestionRow` to `@bb/server-contract` and the projection in
  `@bb/thread-view`.
- Extend the resolve route to accept the new resolution variant.
- DB: confirm the existing `pending_interactions` table can carry the new
  payload as JSON; no schema migration needed if so.
- Add a `userQuestion: "supported" | "unsupported"` capability on the provider
  catalog and default every provider to `unsupported` for now.

### Phase 2 — Claude Code adapter

- Extend the Claude adapter to decode the native `AskUserQuestion` tool call
  into our `user_question` payload and to encode `user_answer` back into the
  shape Claude expects.
- Flip Claude's catalog capability to `supported`.
- End-to-end smoke test: managed thread, Claude provider, asks a question,
  answers, resumes.

### Phase 3 — UI

- New question timeline row component reusing approval-row primitives.
- Inline answer controls (chips, multi-select, free text) keyed by question
  `id`, with submit.
- Compose-box "agent is waiting" state.
- UI hides / disables question affordances when the thread's provider has
  `userQuestion: "unsupported"`.

### Phase 4 — Agent instructions

- Update `manager-agent-instructions.md` and `standard-agent-instructions.md`
  to document when to ask the user (genuine ambiguity blocking progress) and
  when *not* to (when the answer is in the working directory, project
  preferences, or recent thread history).

### Future — Additional providers

Not in scope for v1. When prioritized: extend Codex and/or Pi adapters using
the strategies sketched in the capability matrix (pass-through when the
provider has a native primitive; host-injected dynamic tool when it doesn't).
No contract or UI changes should be required at that point.

## Exit Criteria

- A Claude Code thread can ask a question through the new primitive; the
  thread pauses, the UI renders the question, the user answers via the inline
  controls, and the thread resumes with the answer reflected in the next
  provider message.
- Closing the thread / interrupting the turn while a question is pending
  resolves the pending interaction to `interrupted` cleanly with no orphaned
  state.
- Capability flag is wired and the UI degrades cleanly for any provider with
  `userQuestion: "unsupported"`.
- Data model contains no Claude-specific field names, constraints, or
  assumptions. A reviewer reading `@bb/domain` could not tell which provider
  ships first.
- Tests cover: lifecycle (pending → answered, pending → interrupted), schema
  validation rejecting malformed payloads, timeline projection for each state,
  end-to-end via integration test against an in-memory provider stub that does
  not borrow Claude's shape.

## Validation

- `pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/server-contract
  --filter=@bb/agent-runtime --filter=@bb/thread-view --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/integration-tests --force`
  (route + lifecycle, pipe to file per AGENTS.md testing rules)
- Manual smoke via `pnpm bb:dev`: spawn a Claude Code thread, force a
  question (prompt or fixture), answer via UI, confirm timeline + resumption.
- Manually inspect that the Codex and Pi adapters compile and run unchanged
  with the new contract present but their capability set to `unsupported` —
  no regressions, no accidental coupling.
