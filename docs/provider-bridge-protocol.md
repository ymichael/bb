# The bb Provider Bridge Protocol

The one JSON-RPC contract between the agent runtime and every provider
bridge process. Message schemas live in `@bb/provider-bridge-protocol` and
are the source of truth for both sides; this document adds what schemas
cannot express — the division of labor and the grammar: **the bridge knows
the dialect, the runtime knows the timeline.** A bridge parses its
provider's traffic into a narrow grammar of semantic deltas
(`thread/delta`); the runtime's delta assembler owns every timeline
invariant — id minting, turn/item lifecycle, ordering — and constructs the
canonical `ThreadEvent`s. The conformance kit enforces the testable rules
against every bridge in CI.

## Where a bridge lives

A bridge ships inside its plugin's **`bb.host` artifact** — the same artifact
a host RPC entry ships in, and one plugin may carry both. It is an _export_,
not a program:

```ts
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start({ pluginId, dataDir, tempDir }) {},
  onClose() {},
});
```

`bb plugin build` bundles the artifact to `dist/host.js`; the server records
it content-addressed and hands hosts `{pluginId, digest}`; the daemon
downloads, verifies, caches and runs it — through a bootstrap that owns
everything outside the protocol: argv, the plugin-scoped `dataDir`/`tempDir`
above, the bounded stdin framing, and the signals. A bridge that started
itself could not be imported by a test, and could not share an artifact with a
host RPC entry. First-party bridges use exactly this path —
`plugins/provider-codex/src/bridge/bridge.ts` is the largest worked example,
and `examples/plugins/echo-provider` the smallest.

The bundle is self-contained (only node builtins stay external) and may not
import bb's private `@bb/*` workspace packages at all — an installed plugin
cannot resolve them. Everything a bridge compiles against is published at
**`@get-bb/plugin-sdk/provider-bridge`**: the protocol schemas (including
the `thread/delta` grammar), the bridge kit (JSON-RPC plumbing, tool-call
and interaction codecs, visibility, dialect-parsing helpers), and the domain
vocabulary the params reference, and the testing kit a bridge proves itself
with — the conformance scenarios, the real delta assembler, the JSON-RPC
harness and the calibration normalizer — is published beside it as
**`@get-bb/plugin-sdk/provider-bridge/testing`**. In-repo, those are
implemented by `@bb/provider-bridge-protocol` (the grammar, the
`assembler`, `conformance` and `testing` subpaths) and `@bb/domain`.

## Transport

Line-delimited JSON-RPC 2.0 over the bridge process's stdin/stdout, in both
directions. Requests and responses are discriminated on the presence of
`method`, never on result shape. The two directions use independent id
spaces.

Hygiene rules (each traces to incident #853):

- An undecodable or schema-invalid request is answered with
  `INVALID_PARAMS (-32602)` carrying the validation issues. Never silently
  dropped — a dropped request is an undebuggable 30-second timeout.
- An unrecognized method is answered with `METHOD_NOT_FOUND (-32601)`.
- Anything written to stdout that is not protocol traffic is ignored by the
  reader; bridges must guard stdout against stray writes.

## Versioning and capabilities

`initialize` exchanges `{protocolVersion, capabilities}` in both directions.
The current version is **2** (the narrow-grammar cutover: `thread/delta`
replaced `thread/event`); the runtime rejects a bridge answering another
version with a legible startup error, since a version-1 bridge would
otherwise connect and produce a silently empty timeline. The version bumps
only for breaking changes; everything additive rides capability tolerance:
unknown methods answer `-32601`, unknown notifications are ignored, unknown
capability fields pass through. Bridges version with their plugin, not with
the daemon — that decoupling is the protocol's reason to exist.

Handshake capabilities are **session-behavior facts** (`sessionRestore`,
`threadArchive`, `threadRename`, `threadGoalClear`, `fork`,
`approvalEnforcedBy`, `grammarVersions`, `steerMode`). They are reported by
the code that implements them, so they cannot drift from behavior.
`grammarVersions` is the inclusive `[min, max]` range of the `thread/delta`
grammar the bridge speaks (default `[2, 2]`: a bridge that says nothing
speaks the grammar that shipped with the protocol version it negotiated),
which is how the vocabulary can change without a protocol bump. The runtime
states its assembler's range in the `initialize` params and both sides use
the highest common version; today the assembler speaks **v3 only**
(`[3, 3]`), so every bridge reports `[3, 3]` and a bridge whose range
misses 3 — including one that predates the field — is refused at spawn with
a legible error. `steerMode` says whether `turn/steer` is
injected into the live model loop (`inject`) or held for the next prompt
boundary (`queue`, the default and the conservative reading). The runtime never sends a
capability-gated method to a bridge that did not advertise it. A handshake
fact may only _narrow_ what the provider's declaration advertises (a
declared fork affordance can turn out unavailable for this agent), never
widen it.

The sessionless `provider/health`, `provider/usage`,
`provider/installation/status`, and `provider/installation/run` methods are
different: their support is declared by each provider through
`bb.providers.register`, so the server can skip an
unsupported host probe and clients can omit providers that never expose usage
or installation management before a bridge has started. A shared bridge may
declare health or usage for every provider it owns and still return
`{ supported: false }` for one provider id; a successful usage result may
likewise contain an empty `windows` array.

Installation has a deliberately split execution boundary. The bridge owns
provider-specific discovery, version/source comparison, and the install/update
decision. `provider/installation/status` returns that state plus a display-only
command. A status request may include a typed operation requirement such as
`thread_rewind`; the bridge owns the minimum provider version needed for that
operation and reports it through the ordinary installation status. When the
host daemon gates a thread start or rewind on that status, it remembers the
answer per provider, bridge launch, and requirement for a few minutes rather
than probing before every thread, and forgets it after an install or update
it ran itself or a shell-environment change. An answer with
`versionUnsupported: true` is never remembered, and neither is one with
`installed: false` from a bridge that reports a `minimumSupportedVersion`,
because an install that arrives without a shell-environment change could be
too old; a not-installed answer from a bridge that reports
`minimumSupportedVersion: null` is remembered like a supported one, since
that bridge can never reject the start. When the
user acts, `provider/installation/run` rechecks the state and
returns either `available: false` or a typed executable/argument plan with a
post-run verification rule. The host daemon—not the bridge, server, or browser—
chooses the environment and working directory, serializes installations,
supervises the process, streams output, and asks the bridge for fresh status to
verify success. Raw executable arguments never cross from the host daemon to a
product client.

Every capability listed there gates a request method, which is why the set
holds no compaction fact. Compaction is triggered by a standalone builtin
`/compact` prompt travelling the normal turn pipeline, which each bridge maps
to its provider's compaction command; there is no compact request method, so
there is nothing to withhold and nothing for a handshake fact to gate. The
`/compact` affordance is gated solely by the provider declaration's
`supportsManualCompaction`, which the ACP bridge needs per agent because the
agents it serves differ on it — a process-level handshake, which runs before
any session exists, cannot answer that question at all. A structured
compaction request is future work — reintroduce it only with a sender, and
only then does it earn a handshake capability.

## The timeline lane: `thread/delta`

Everything timeline-bound rides one notification: `thread/delta
{ threadId, deltas }`. A delta is a parsed _semantic_ unit — `turn.open`,
`turn.boundary`, `input.accepted`, `item.open`/`item.close` with a full item
shape, streamed text (`item.textDelta`/`item.textClose`), `usage`,
`contextWindow`, errors/warnings, `unhandled` diagnostics, session lifecycle
(`session.reset`, `session.ended`) — never a raw provider event and never a
finished `ThreadEvent`. The schemas in
`@bb/provider-bridge-protocol/src/thread-delta.ts` are the source of truth
for the grammar.

The runtime's **delta assembler** (`@bb/agent-runtime`, one per bridge
adapter) consumes the deltas and owns every timeline invariant:

- **Id minting.** Turn and item ids are assembler-minted
  (entropy + serial, the #1224 discipline held centrally, reset per
  `session.reset`). Deltas carry provider-native join keys (tool-call ids,
  stream keys, parent refs, optional provider turn ids) and the assembler
  holds the bidirectional provider↔bb maps — both for scoping incoming
  deltas and for reverse-mapping bb ids on the command plane
  (`turn/steer.expectedTurnId`, `thread/stop.activeTurnId`) and on
  provider-native interaction requests (`providerNativeIds: true`). An
  `interaction/request` carries an approval, a user question, or a
  plugin-defined request (`"<pluginId>/<name>"`); the resolution pairs with
  the payload kind (docs/provider-plugin-api.md §4).
- **Turn lifecycle.** Only `turn.open`, a claiming `turn.boundary`
  (`claimIfIdle`), and accepted-input lifecycle settlement ever open a
  turn; item/stream deltas never do. Accepted input queues until a turn
  opens and drains into it.
- **Item lifecycle.** Delta-first streams get a synthesized `item/started`;
  `item.close` always carries the full terminal item shape and is applied
  uniformly (paired close, reclassifying dual-settle, or bare
  close-without-open); repeated closes for a settled provider-identified
  key are deduped and an explicit reopen reuses the same bb id.
- **Accumulation.** Streamed text, cumulative output snapshots (diffed into
  deltas/resets), and progress-event throttling.
- **One streaming dialect.** Every text stream is an item keyed like every
  other item: by the provider's own item id when it names its message items
  (codex), or by a bridge-chosen `key.channel` (`assistant`, `thinking-2`)
  plus `key.parentRef` for anonymous streams (claude, pi, acp).
  `item.textDelta { key, channel: agentMessage | reasoningText |
reasoningSummary | plan, text }` synthesizes the channel's `item/started`
  on first sight and accumulates; `item.textClose { key, channel, text? }`
  settles with the provider-final `text` or, absent that, the accumulated
  stream (a whitespace-only stream completes nothing), and releases the
  key. A tool `item.open` releases the anonymous assistant stream in its
  scope so later text mints a fresh item; provider-named items keep their
  own lifecycle and may settle through `item.close` with the full terminal
  shape like any item. `session.ended` settles a streamed item with the
  text it received.
- **One usage dialect.** `usage { total, last, modelContextWindow }` is
  forwarded verbatim as `thread/tokenUsage/updated`: a provider with exact
  cumulative totals (codex) sends both as reported, and a provider that
  reports per turn (claude, pi) sums `last` into `total` itself
  (`addTokenUsage` in the bridge kit), resetting where it sends
  `session.reset`. The context meter is always the separate `contextWindow`
  delta, which may name a vouched `providerTurnId` (codex sends one beside
  each `usage`).
- **Streamed-text batching.** Coalescing is assembler policy, not bridge
  policy: within a per-stream flush window (`textDeltaFlushMs`, 100ms
  default, 0 disables) consecutive streamed-text events — assistant/
  reasoning/plan deltas and command/fileChange output deltas, including the
  ones the assembler's own snapshot diffing produces — concatenate into a
  single event of the same type, so chatty providers stop producing one
  timeline event per token. The first delta of a fresh stream emits
  immediately (time-to-first-token unchanged); buffers flush trailing-edge
  with no timers (the thread's next traffic once the window elapses, stream
  close, session boundaries); and every non-batchable event is an ordering
  barrier — coalescing never reorders text relative to item opens/closes,
  turn events, errors, or other streams' flushes. An output `reset` is never
  absorbed into a concatenation; `session.reset` flushes buffered text
  (assembled against the old session's still-valid ids) before dropping the
  thread's state.
- **Settlement.** `session.ended` and settling errors close open turns and
  items with the right statuses.

### Grammar v3

The target provider-plugin surface ([provider-plugin-api.md](provider-plugin-api.md))
grew the delta vocabulary into grammar v3: new union members and optional
fields beside the v2 grammar, plus one streaming dialect and one usage
dialect replacing v2's two of each (`message.delta`/`message.close` and
`usage.turn`/`usage.exact` are deleted). The protocol version stays at 2 —
the envelope and the method vocabulary did not change — and the grammar
range is what gates a bridge: every bridge in this repo reports
`grammarVersions: [3, 3]`.

- **Core item shapes** `fileRead`, `search` (`mode: content | path | list`),
  `delegation` (`childRef`, `label`, `background`, `summary?`; one shape for
  codex `spawnAgent`/`wait`, the Claude `Agent` tool, and backgrounded
  agents, which replaced `thread/openWork`), and `planSteps` (a structured plan
  snapshot as an item, which replaced the turn-level `turn.plan` delta once
  the ACP bridge — its last speaker — migrated).
- **`presentation`** on `item.open` and `item.close`, the one place it
  travels: `label {pending, completed}`, `icon {glyph}` (a host glyph such
  as `"FileText"`, or one of the emitting plugin's declared icons as
  `"<pluginId>/<name>"` from `bb.branding.experimental_icons`; the server
  replaces a namespaced glyph the plugin did not declare with
  `provider/unhandled` at ingest — never a path or bytes), `title?`,
  `detail?` (≤ 280 chars), `suppress?`, `tint?`. The assembler persists it
  on the canonical item (the close's value wins, the open's survives when
  the close carries none), so the row renders after the plugin is gone and
  mobile renders every kind without plugin code. Optional for core shapes
  until the v2 paths are deleted; required when the shape is `extension`.
  Conformance rule `presentation/icon-namespaced-declared` checks the
  namespaced form for bridges that opt in with an `icons: { pluginId, names }`
  fixture field (no result when the field is omitted); a `server: "bb"` tool
  row is exempt, its glyph being checked against the tool's own plugin.
- **bb-injected tools carry their presentation.** Every `dynamicTools[]`
  definition on `thread/start`, `thread/resume` and `thread/fork` carries the
  `presentation` the server resolved for it (from the owning plugin's
  `presentation`, or a generic label and the plugin's glyph). A bridge stamps that presentation, beside `server: "bb"`,
  on the `item.open`/`item.close` of every call to the tool, so no tool-name
  table labels bb tools anywhere downstream. Optional on the wire: a definition recorded before the field existed
  presents generically, and the committed recordings predate it, so it stays
  optional until those are re-minted.
- **Extension kinds** `"<pluginId>/<name>"`: the `extension` item shape
  (opaque JSON `payload`; its lifecycle delta must carry a `presentation`)
  and the thread-scoped
  `extension.state` delta (latest snapshot wins per kind). Only the namespace
  is validated on the wire; the server validates payloads against the
  plugin's declared schemas at ingest, and refuses a kind whose plugin is not
  the one that registered the thread's provider — a bridge emits only its own
  plugin's kinds.
- **`provider/recovery`** is a bridge → runtime _notification_ beside
  `session/replaced`, not a delta: `{ threadId?, kind: sessionArchived |
authRequired | restartRecommended | staleTurn | rateLimited, message,
retryable }`. The runtime acts on the kind and never matches error text.
  See "Recovery hints" below for the actions and the carrier.

### Injected skills

`skills/configure { roots: [{ id, path, skills: [{ name, description }] }] }`
is one shape for every provider: `path` is an absolute skills directory, one
subdirectory per listed skill (`<path>/<name>/SKILL.md`). The bridge maps it
to its provider's own layout. The runtime sends it **only to a bridge whose
handshake declares `skills: { configure: true }`**, once per process, before
the first thread command; a bridge that declares nothing never receives it
and runs without injected skills, so a bridge that answers unknown methods
with `METHOD_NOT_FOUND` still starts threads. The runtime never probes.
Conformance rule `skills/configure-declared` pins both directions: declared →
the request must succeed; undeclared → the request must be refused.

### Recovery hints

A hint says what went wrong in the provider's own terms and what the runtime
may do about it. The `provider/error` delta beside it still carries the
user-visible row; the hint carries the action. The runtime keys on `kind`
only and never consults the provider id:

| `kind` | Runtime action |
| --- | --- |
| `sessionArchived` | `thread/unarchive` the session, then retry the rejected request once (`retryable: true`). |
| `authRequired` | Reject the request with a typed `auth_required` error (no text match anywhere downstream) and forward the hint so the host can re-check provider health. |
| `restartRecommended` | Stop the bridge process the thread runs on and resume the thread on a fresh one — right away when the thread is idle, otherwise before its next turn. The restart waits while another thread on the same process is mid-turn or holds open background work, and never re-resumes a sibling the host already resumed on the replacement. |
| `staleTurn` | Drop the steer: the turn it targeted is gone, and the runtime reports the steer as stale instead of failing it. |
| `rateLimited` | With `retryable: true` on a rejected request: retry on a short bounded ladder and surface the last failure. With `retryable: false` (a turn that already failed): forward only; the runtime never re-runs a user's turn on its own. |

The action follows the hint whichever attempt it arrives on: a rung of the
rate-limit ladder or the retry after an unarchive that is rejected with
another kind gets that kind's action exactly as a first rejection would. The
one bound is the unarchive itself — a second `sessionArchived` on the retry is
reported, not unarchived again.

One payload, two carriers. **Rejecting a request? Put the hint in
`error.data.recovery`.** A hint that explains a rejected runtime request (a
resume against an archived session) rides that request's JSON-RPC error
response as `error.data.recovery { kind, message, retryable }`; the JSON-RPC
`id` is the correlation, and the payload names no thread because the request
already does. A handler throws `experimental_BridgeRecoveryError` and
`runBridgeRequest` writes the response, or it calls
`sendError(id, code, message, { recovery })` by hand; the ACP bridge answers
`model/list` and `thread/start` this way when the agent needs the user to sign
in (`kind: "authRequired"`). **No request to reject? Send
`provider/recovery`.** The notification is for unsolicited hints
only — a terminal 401 or 429 the provider raised mid-turn, an SDK auth
failure — and carries `threadId` for a session-scoped condition. That
`threadId` must name a thread the sending process hosts: a process speaks only
for its own threads, so a hint naming any other thread is dropped (with a
stderr line) before it can act on another process's bridge. Never send
both for one event. `data` is optional and additive; a response without it,
or with a malformed one, is a plain failure, and a request that times out or
whose bridge exits has no response and therefore no hint.

A bridge that can heal itself does not ask the runtime to: the codex bridge
rebuilds a thread's `codex app-server` child before the next turn after a
terminal account error, and the claude bridge replaces its CLI child the same
way; both still emit `authRequired`/`rateLimited` so the failure is typed.

The assembler builds every v3 core kind: `fileRead`, `search` and
`planSteps` open pending and settle from the terminal shape like `command`;
a foreground `delegation` settles through the turn-scoped `item/completed`,
and a `background: true` delegation is thread-attached like a background
task — its `item.progress` snapshots and its `item.close` ride the
thread-scoped `item/delegation/progress` and `item/delegation/completed`
events, need no open turn, and survive turn settlement and `session.ended`.
The assembler reports `grammarVersions: [3, 3]` (`ASSEMBLER_GRAMMAR_VERSIONS`),
v3 only, as the handshake section above says. An `extension` shape
becomes the canonical `extension` item (opaque payload, the delta's
presentation); `extension.state` becomes the thread-scoped
`thread/extensionState/updated` event. The server validates both payloads
against the owning plugin's declared `extensionKinds` schema at
ingest (64 KiB cap), and holds the kind to the same emitter rule as a
namespaced presentation glyph: the plugin the kind names must be the plugin
that registered the thread's provider. A kind another plugin owns, an
undeclared kind, or a schema miss is persisted as a
`provider/unhandled` in the same batch slot, never dropped and never stored
unvalidated.

## Identifiers

Three identifier families, three owners:

| Identifier                              | Minted by                   | Notes                                                                                                                                                                                                |
| --------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threadId`                              | bb server                   | Opaque to the provider; echoed verbatim.                                                                                                                                                             |
| `providerThreadId`                      | the provider                | Its session handle (rollout id, session id). Returned on the `thread/start`/`thread/resume`/`thread/fork` result (required) and echoed by `thread/identity`; never used to scope bb events directly. |
| turn ids and item ids on `ThreadEvent`s | **the runtime's assembler** | Never the provider, never the bridge.                                                                                                                                                                |

The central-minting rule is the #1320 lesson made structural: a provider can
inject arbitrary identifiers on its own wire, but the ids that reach bb's
persistence are always minted by bb-owned assembler code. Bridges forward
provider-native ids as vouched join keys on deltas; the assembler translates
in both directions, so a bridge does zero id translation — including for a
provider that mints its own turn ids (codex).

## Turn lifecycle

State machine per thread, owned by the runtime's assembler, fed by the
bridge's deltas:

```
accepted → dispatched → started → (completed | failed | interrupted)
```

The assembler constructs the events; the bridge owes the deltas that drive
it:

1. Every accepted `turn/start` or `turn/steer` reaches exactly one terminal
   state. Acceptance rides `input.accepted { clientRequestId }` — mandatory,
   so correlation is explicit and the runtime never guesses which user
   message opened a turn; the assembler queues it until a turn opens (or
   emits into the already-open turn for steers) and constructs
   `turn/input/accepted` itself. Settlement rides `turn.boundary
{ status }`; a boundary with `claimIfIdle: true` owns a turn only when
   accepted input is pending, so a provider-terminal fallback signal on an
   idle thread settles nothing. A prompt the provider handles without doing
   work (claude `/clear`) still produces a `turn.open` + `turn.boundary`
   pair — zero-delta acceptance is the #1431 hung-thread class. Conformance
   rule `turn/settles-without-activity` checks this for bridges that opt in
   with a `zeroWorkPromptInput` fixture prompt.
2. Item and stream deltas never open a turn. A turn-requiring delta that
   arrives with no turn open surfaces its `noTurnFallback` payload as a
   thread-scoped `provider/unhandled`, or is dropped when the bridge
   attached none.
3. A turn the user did not initiate (provider-internal activity such as
   auto-compaction) either becomes an explicit bridge-emitted `turn.open`
   with its own deltas or rides `provider/raw` / `unhandled` diagnostics.
   Turn-scoping is vouched: only turn keys the bridge itself opened may
   scope a delta (`vouchedTurn`, keyed `providerTurnId`s) — a provider's
   own internal turn labels must never be forwarded as scoping.
4. The runtime backstops the bridge with a turn-start watchdog: an accepted
   turn with no `turn/started` within a bound becomes a visible
   `system/provider-turn-watchdog` event, not a silently hung thread.
5. `thread/stop` semantics follow its `intent`: `interrupt` settles the
   active turn as interrupted (the bridge emits the settling deltas —
   `turn.boundary { interrupted }` plus explicit closes for provider-owned
   open items); `release` detaches an idle session and must not fabricate an
   interruption (#1584). The bb turn ids these commands carry are
   reverse-mapped to the bridge's provider-native turn ids by the adapter,
   so the bridge compares its own ids.
6. **After `thread/stop` the bridge holds nothing for the thread.** The
   runtime detaches the thread the moment the stop is answered, whichever
   the intent, so everything the bridge still owes for that thread — the
   interrupted turn's terminal boundary first of all — must be on the wire
   before the response, and any per-thread resource the bridge runs (a
   provider CLI child, an SDK session) is released before or with it. A
   provider that settles an interrupt asynchronously waits for it, bounded,
   and settles the turn itself on timeout; the session on disk stays
   resumable either way. Conformance rule
   `stop/interrupt-settles-before-result`; the runtime backstops a session
   construction that timed out on its side with a best-effort
   `thread/stop { release }` before it forgets the thread, and sweeps a
   bridge's process group when the bridge dies unexpectedly.

## Item lifecycle

Assembler-owned invariants over the assembled timeline:

1. **Every item's first event is `item/started`.** The assembler synthesizes
   the opening event for delta-first text streams (`item.textDelta`), so a
   bridge streams without bookkeeping. Output
   deltas (`item.outputDelta`) never synthesize — a command item without
   its command would be worse than the anomaly — but still register the key
   so a later open correlates.
2. `item.close` always carries the full terminal item shape. The assembler
   settles uniformly: a same-shaped open item settles under its minted id
   with the carried shape winning; a different-shaped open item is settled
   first and the terminal shape follows under the same id (mid-flight
   reclassification); close-without-open builds the bare completed item.
3. Item ids are unique across the life of a thread, including resumes: the
   assembler's maps survive within a session and `session.reset` (mandatory
   at every provider session construction) starts a fresh provider id space
   so reused provider-native ids mint fresh bb ids.
4. Completion follows content from the bridge's perspective: if the provider
   emits completion before the content it refers to (codex `item.close`
   before the stdout record), the bridge holds the close delta and flushes
   in order. Output may be delayed, never lost (#1400).

## Host-side enforcement

The conformance kit only covers bridges someone ran it against, and a bridge
now ships as a plugin artifact that may be third-party. So the host also
applies the grammar live, at its event intake (`ThreadEventGrammar`, over
the assembler's output): a
streaming event for an item no `item/started` opened, a second settlement of
an item, a duplicate `turn/started` or `turn/completed`, and a
`turn/completed` for a turn that never started are dropped before any runtime
state changes, each with a warning naming the rule. An item that settles
without opening is the one non-conformance kept rather than dropped — it
carries the whole item, so refusing it would lose real content.

## Sessions

1. `thread/start`, `thread/resume`, and `thread/fork` return
   `{providerThreadId, sessionRestorable?}`. The per-session
   `sessionRestorable` refines the handshake default and is re-reported by a
   replacement session — a stale `true` lets the idle sweep release a
   session that cannot come back.
2. **Session replacement is never silent.** Whenever the bridge tears down
   and rebuilds a live provider session — an option it cannot apply in
   place, a resume fallback, internal recovery — it first emits any
   settlement deltas for in-flight work, then `session/replaced` with a
   human-readable reason and `contextLost` when provider-side context did
   not survive. Invisible replacement is the #1268 incident.
3. Execution options ride every command. The bridge reconciles them
   internally; the runtime never diffs. Instructions are frozen for the life
   of a session and apply at the next construction.
4. Fork: absent `sourceProviderCheckpointId` means fork at the tip. A
   `fork: "tip"` bridge rejects checkpoint forks with
   `FORK_CHECKPOINT_UNSUPPORTED` rather than cloning history the bb timeline
   does not show.
5. Open work is what the timeline says it is. A `backgroundTask` item and a
   `delegation` item that are still pending are live provider work, and the
   runtime will not reap the session while one is open. Model a native
   sub-agent as a `delegation` (codex does), re-open it when the agent works
   again, and settle it — as failed — when your provider child dies, or the
   runtime keeps refusing to reap a thread that no longer exists on your
   side. There is no side channel for this (the former `thread/openWork`
   notification is gone; a runtime ignores it).

## Ordering guarantees

Producers guarantee:

- `thread/identity` for a session precedes any `thread/delta` for it.
- Within a turn, deltas are emitted in presentation order (the assembler
  preserves it in the assembled events); across turns, turn boundaries are
  strict.
- Settlement deltas precede the `session/replaced` that made them
  necessary.

Consumers must NOT assume:

- That a request's response arrives before notifications caused by the
  request (`turn/started` may precede the `turn/start` response).
- Anything about `provider/raw` — it is droppable at any pressure point and
  carries no ids the runtime treats as bb identifiers.

## Parsing discipline

Lenient at the edges, strict at the core. Wire schemas tolerate unknown
fields (forward skew between plugin and daemon versions is normal). One
malformed entry degrades to one missing entry — a bad model in `model/list`
drops that model, not the listing; a malformed notification is logged and
dropped without poisoning the stream. But a `thread/delta` payload must be
a valid delta: what it assembles into enters bb's persistence, so the core
stays strict.

## Child processes

Bridges may spawn provider processes underneath themselves (the codex bridge
supervises per-thread app-server children); process topology is
bridge-internal and invisible to the runtime. Bridges that spawn children
own the exit-race lessons the runtime learned (#1402): finalize on `close`
not `exit` with a bounded grace, verify currency in stream callbacks, and
never let a descendant holding an inherited pipe inject into a fresh
session. Before spawning a bridge, the runtime drops inherited `NODE_ENV` and
every `BB_*` name (#1366), pins `PATH` to the login-shell value, adds
`BB_PROVIDER_BRIDGE_RECORD_DIR` in record mode and `ELECTRON_RUN_AS_NODE` when
needed, and re-adds each nonempty value named by the provider declaration's
validated `env.passthrough` list. This is a denylist, not a general inherited-
environment barrier: ordinary provider auth, proxy, and platform variables
remain, as does the Volta guard in #1545. Provider child builders retain that
ordinary inherited environment, with per-session overrides where applicable;
`withoutBridgeRuntimeEnv` removes the bridge-only `ELECTRON_RUN_AS_NODE` and
`BB_PROVIDER_BRIDGE_RECORD_DIR`, and individual bridges may sanitize further.

## Record mode

Set `BB_PROVIDER_BRIDGE_RECORD_DIR` to a directory and every bridge process
tees the lines that cross its two boundaries into NDJSON files. The bootstrap
(`bridge-worker-entry.ts`) records the runtime wire for every bridge, first-
or third-party. A bridge that spawns its provider child records the provider
wire by calling `experimental_recordProviderChildIo(child, { threadId })`
right after `spawn()`; the call is a no-op when record mode is off. A bridge
whose provider pipe belongs to an SDK checks
`experimental_isProviderBridgeRecording()` and takes the spawn over (the
Claude bridge does this through the Agent SDK's `spawnClaudeCodeProcess`
seam). The pi bridge also records the bb extension's channel (fd 3 / fd 4)
on the same two provider lanes, each message wrapped as
`{ "bbChannel": <message> }`, so a replay can route it back onto the fds.

Layout: `<dir>/<threadId>/<direction>.ndjson`, with `_process` for lines that
belong to no thread (`initialize`, `model/list`, provider health, and the
children those spawn). The four directions are `runtime→bridge`,
`bridge→runtime`, `provider→bridge`, and `bridge→provider`. One entry per
line: `{ "ts", "run", "seq", "dir", "line" }`. `seq` is one counter across
every lane of the process and `run` identifies the process, so the files of a
thread merge back into their exact order even across a bridge restart.
Responses, which carry only an id, land in the scope of the request they
answer. Nothing buffers: each line is appended as it crosses.

The daemon forwards the variable to the bridges it spawns and the runtime
appends the provider id, so a daemon started with it writes
`<dir>/<providerId>/<threadId>/…`. `withoutBridgeRuntimeEnv` strips the
variable from provider children, so a recorded provider never records itself.

Recordings are the input of the parity harness
(`packages/provider-bridge-protocol/src/testing/parity.ts`): the provider
lanes replay into a fake child (`replay-provider-child.mjs`, for which the
recording is the script), the runtime lanes replay into a bridge, and two
checkouts are diffed on the assembled events and projected rows with
`pnpm parity --old <checkout> --new .` (`@bb/provider-parity`). Each leg
assembles and projects with its own checkout's code. Differences a migration
PR intends go in `recordings/parity-allowlist.json` with the PR and reason;
an entry that masks nothing is reported stale and fails the run.

Redacted recordings live under `packages/provider-bridge-protocol/recordings`,
one `<provider>/<cell>` directory per live-QA matrix cell with a
`manifest.json` (provider, cell, CLI version, date, what the session did);
`scripts/provider-recordings/redact.mjs` and `package-cells.mjs` produce
them. `recordings/row-counts.json` pins each cell's event, row,
`provider/unhandled`, and grammar-drop counts; `parity.self.test.ts` checks
the pins and replays every cell through the current bridge on each commit,
and `UPDATE_PARITY_ROW_COUNTS=1` rewrites the pins deliberately. Raw
recordings stay out of git.

A recording is never rewritten. When a bridge change alters what the bridge
emits for a recording, `pnpm --filter @bb/provider-parity rerecord
[--plan-with <recording-time checkout>]` writes the bridge's current output
to `bridge→runtime.current.ndjson` beside the recorded lane; the self-suite
pins and compares against that file when it exists, while `pnpm parity`
still paces a pre-migration leg from the recorded lane (and the current leg
from the current one). `pnpm parity --dump-dir <dir>` writes both legs'
normalized event and row lists per cell, for allowlist entries that must
name a list index. Re-recorded lanes pass through `redact.mjs` before they
are written. The committed current lanes are the v3 bridges' output for the
v2 recordings: the stack's assembler reads only v3, so every replayable cell
carries one, and they assemble to the same pinned counts as the recordings.

The conformance kit runs the same recordings as its recorded-traffic
scenario set: `checkRecordedCellReplay` replays a bridge's cells and
`checkRecordedCellReplay` reports `recorded/<cell>/{replays,
events-schema-valid, grammar, turn-lifecycle, not-empty}` per cell. Each
first-party bridge has a `bridge.recorded-conformance.test.ts` beside its
scripted suite, so conformance reflects the real dialect as well as the
protocol.
