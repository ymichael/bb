# APIs To Audit

## `bb.http.experimental_websocket`

**What it does.** Registers an exact-path WebSocket upgrade in the plugin's
existing `/api/v1/plugins/<id>/http/` namespace. It shares HTTP route auth
modes, gives the plugin the upgrade request metadata, normalizes incoming text
and binary frames, and closes sockets from a replaced or disabled plugin
generation with code 1012. The supporting public types are
`ExperimentalPluginWebSocket`, `ExperimentalPluginWebSocketContext`,
`ExperimentalPluginWebSocketHandler`, and
`ExperimentalPluginWebSocketHandlers`; the testing harness exposes
`experimental_openWebSocket`, `ExperimentalFakeWebSocketRouteRecord`, and
`ExperimentalFakeWebSocketSession`.

**Audit before stabilizing.**

1. Confirm the HTTP namespace and exact-path rule cover plugin proxy use cases
   without a separate WebSocket namespace or parameterized routing.
2. Decide whether subprotocol negotiation belongs in the context or returned
   handler contract.
3. Confirm string and `Uint8Array` are sufficient for frame data and sends.
4. Confirm code 1012 is the right reload/disable signal and whether plugins
   need a distinct disposal reason.
5. Confirm the callback error policy should keep the socket open after an
   isolated message-handler failure.

## `bb.providers.experimental_contributeEnvHealth`

**What it does.** Registers one host-scoped readiness resolver beside a
provider environment contribution. When the provider bridge reports
`unauthenticated` or `expired`, the server may present the provider as ready
with the returned label and status message. Returning `null` preserves the
bridge result. The resolver is ignored unless the same plugin also contributes
environment variables to that provider. The resolver receives an
`ExperimentalPluginProviderEnvHealthContext` and returns an
`ExperimentalPluginProviderEnvHealth` or `null`.

**Audit before stabilizing.**

1. Confirm readiness should override only `unauthenticated` and `expired`, not
   installation or unknown failures.
2. Decide whether the contribution should report account identity or usage in
   addition to a label and status message.
3. Confirm the first available resolver in plugin load order is the right
   arbitration when several credential proxies target one provider.
4. Confirm a five-second timeout is appropriate for host-scoped credential
   availability checks.

## `bb.providers.experimental_contributeEnv`

**What it does.** Registers one resolver per provider per plugin. The server
calls it for each matching session and turn with the thread, project, and host
ids, validates at most 32 environment entries, resolves registration conflicts
in plugin load order, and sends the winning values to the host. A value may be
a literal string or a server-relative path that the host expands against its
authenticated `BB_SERVER_URL`. Contributions override the shell environment;
entries marked `secret` are masked in provider environment events. The resolver
receives `ExperimentalPluginProviderEnvContext` and returns
`ExperimentalPluginProviderEnvEntry` values.

**Audit before stabilizing.**

1. Confirm one resolver per provider is sufficient when plugins need multiple
   independently disposable features.
2. Confirm plugin load order is the right deterministic conflict policy.
3. Confirm the 32-entry cap and five-second timeout fit providers that resolve
   short-lived credentials.
4. Decide whether `serverPath` needs structured query parameters or non-HTTP
   server endpoints before accepting more shapes.
5. Confirm `reason` should remain required and whether event consumers need a
   stable machine-readable purpose beside it.
6. Decide whether the context and entry types should stabilize with the method
   or remain experimental for a longer compatibility window.

Every public plugin API member ships with an `experimental_` prefix and an
entry here (see [AGENTS.md](../AGENTS.md), "Plugin API"). Dropping the prefix
is the deliberate stabilization step: audit the entry, rename project-wide,
and delete the entry in the same change. Entries that stay experimental after
an audit say so with the date and the open question. The first audit
(2026-08-22, the provider-plugin migration's stabilization) stabilized the
provider declaration's target-state fields and `maintenance`, tool
`presentation`, `UrlLink` / `openUrl`, `fixedTabs`, and the shared `Original`
delegation prop, and deleted the alias and status-label members; the next
bb-app release's CHANGELOG entry records the renames for plugin authors.
For a bridge built against 0.4.15 the renames are mechanical: on
`@get-bb/plugin-sdk/provider-bridge` the sixteen `experimental_provider*Schema`
values and their sixteen `ExperimentalProvider*` types dropped the prefix
(`experimental_providerHealthSchema` → `providerHealthSchema`,
`ExperimentalProviderHealth` → `ProviderHealth`, …), as did the
`BRIDGE_REQUEST_METHODS.experimentalProvider*` keys (the method strings on
the wire are unchanged); on `@get-bb/plugin-sdk` the tool type
`PluginAgentToolExperimentalStatusLabels` is `PluginAgentToolLabels`, the
type of `presentation.label`.

## One-release compatibility windows (removal target: bb 0.42)

- The app runtime keeps deprecated aliases for plugin bundles compiled
  against an SDK before 0.4.16: `experimental_UrlLink` (a wrapper component
  that warns on its first render, then renders `UrlLink`),
  `BbNavigate.experimental_openUrl` (warns on its first call, then calls
  `openUrl`), and the delegation prop `experimental_Original` passed beside
  `Original` on the thread-list, file-opener, source-code renderer and diff
  renderer props (the timeline renderer never carried the old name; the
  alias warns on its first render). A bundle that never uses an alias never
  warns. All go in bb 0.42. The two 0.4.14 `app` exports
  (`experimental_ProviderModelPicker`, `experimental_PermissionModePicker`)
  are present and stay experimental; neither carries an alias.
- The deleted `bb.agents.experimental_registerProvider` throws with the
  removal named on first read (use `bb.providers.register`).
- Removed outright from a published subpath, with no alias and no throwing
  stub (an import fails to resolve): `ProviderInfo.experimental_providerHealth`
  / `experimental_providerUsage` / `experimental_providerInstallation`
  (`@get-bb/plugin-sdk/app`, properties of the `ProviderInfo` rows
  `experimental_useProviders` serves: a typed read no longer compiles and
  the served row has no such key; read `maintenance.health` /
  `maintenance.usage` / `maintenance.installation` — the server no longer
  serves the three booleans beside `maintenance`, and every client ships
  with the server, so no reader is left behind),
  `experimental_aiServiceKindSchema` and
  `ExperimentalAiServiceKind` (`@get-bb/plugin-sdk/ai-services`; the pair
  referenced only each other — the kind a service declares is
  `PluginAiServiceKind` on `PluginAiServiceDeclaration.kinds`, exported from
  `@get-bb/plugin-sdk`, and there is no schema for it), `ExperimentalAiJsonValue`
  (`@get-bb/plugin-sdk/ai-services`; none — import the domain type,
  `JsonValue` from `@get-bb/plugin-sdk/provider-bridge`), and
  `ExperimentalResolvedNativeRoot` (`@get-bb/plugin-sdk/host`; none — import
  the domain type, reachable as
  `ExperimentalNativeRootsResolveOutput["skills"][number]`), and from
  `@get-bb/plugin-sdk/provider-bridge/testing` the three kit internals no
  suite used: `experimental_ConformanceClient` and
  `experimental_checkItemOpensBeforeDelta` (none —
  `experimental_runBridgeConformance` drives the client and applies the
  opens-before-delta rule itself) and `experimental_diffCumulativeText`
  (none — the cumulative-text differ is the assembler's own). Every other
  0.4.15 name of every subpath is still exported, renamed as above or
  listed under the scheduled removals below.
- Renamed declaration, tool and navPanel fields (`experimental_strings`,
  `experimental_presentation`, `experimental_fixedTabs`, …) are rejected at
  registration with a message naming the new field, from SDK 0.4.16 on.
- `experimental_toConformanceMessages` (`@get-bb/plugin-sdk/provider-bridge/testing`)
  throws on call, naming its replacement: `experimental_runBridgeConformance`
  assembles `thread/delta` itself from the raw messages a transport's
  `takeMessages` returns and takes the bridge's `providerId`. A conformance
  suite written against the pre-0.4.16 transport shape fails with that message
  instead of a missing export. Goes in bb 0.42.
- Presentation-less `toolCall` rows pass through the legacy-data adapter
  (`upgradeLegacyToolItem` in `@bb/domain`, applied when a stored row is
  parsed): keyed on the absence of `presentation`, it reshapes
  Read/Grep/Glob and read/grep/find/ls by name into `fileRead`/`search`
  items and suppresses the Task*/Todo*/ToolSearch bookkeeping calls,
  exactly as the deleted tool-name tables rendered them. Persisted pre-v3
  history is its purpose, but the pi bridge's generic `tool` rows carry no
  presentation yet, so its live read/grep/find/ls calls take the same path
  and render as exploration rows (path or query, no output) like Claude's.
  Closing the window: pi stamps `fileRead`/`search` presentation so no live
  row reaches the adapter, then the `legacy-tool-item-backfill` migration
  stamps the old rows, `presentation` becomes required on
  `item.open`/`item.close`, and the adapter, its tests and
  `LEGACY_TOOL_ITEM_BACKFILL_MIGRATION` go together.

## Scheduled removals (next major)

Unprefixed exports of `@get-bb/plugin-sdk/provider-bridge` that no longer
have a consumer in this repository. They are kept on the facade because a
third-party bridge compiled against an SDK before 0.4.16 may import them;
dropping a published name is a breaking change. The first eleven are
re-exported from `@bb/domain`, where each still has core consumers:

- `acpNativeReasoningSchema`
- `acpPermissionCliSchema`
- `acpReasoningCliSchema`
- `extensionKindSchema`
- `interactionRequestPayloadSchema`
- `isExtensionKind`
- `isUserQuestionPendingInteractionPayload`
- `isUserQuestionPendingInteractionResolution`
- `providerRecoveryKindValues`
- `threadEventItemPresentationSchema`
- `threadEventSearchModeSchema`

The next four are aliases of definitions that moved when the host-daemon
wire lost the typed ACP launch spec (protocol 155) and the claude-code
runtime became a plugin: the ACP pair aliases the ACP kit's
`experimental_acpLaunchSpecSchema` / `AcpLaunchSpec`
(`@get-bb/plugin-sdk/provider-bridge/acp`, where a plugin that declares an
ACP agent should read it) and the kit's normalizer; the task-tool pair is a
copy kept in the SDK of what core used to share with the claude-code
runtime, with no replacement. The type aliases `HostDaemonAcpLaunchSpec`
and `ClaudeTaskToolOutput` go with them.

- `hostDaemonAcpLaunchSpecSchema`
- `normalizeHostDaemonAcpLaunchSpec`
- `claudeTaskToolNameSchema`
- `claudeTaskToolOutputSchema`
- `HostDaemonAcpLaunchSpec`
- `ClaudeTaskToolOutput`

All fifteen values and both types: unreferenced by any first-party plugin;
kept because 0.4.x published them; remove at the next major version. The
`provider-bridge-scheduled-removals` SDK test holds the facade to this list.

`AcpAgentProfile` on `@get-bb/plugin-sdk/provider-bridge/acp` is a deprecated
alias of `AcpLaunchSpec` for the same reason. The bridge used to derive a
profile from the parsed launch spec (`providerId`, `agentCommand: { command,
args }`, an `env` dropped when empty) and read only the spec's own fields
from it, so the profile type went with the derivation; the published name
stays until the next major version.

`CONFORMANCE_ASSEMBLED_EVENT_METHOD` (`@get-bb/plugin-sdk/provider-bridge/testing`)
is retired the same way: the conformance kit assembles `thread/delta` itself
and reads nothing under that method, so the constant names a lane that no
longer exists. Kept because 0.4.x published it; remove at the next major
version.

## Settings schemas and server writes

**What it does.** A `PluginSettingDescriptor` can declare an
`experimental_schema` Standard Schema validator that runs on the server for
every proposed value; Zod schemas qualify. Settings schemas must validate
synchronously without transforming their primitive value. The generated form
autosaves one field at a time and displays the first validation issue beneath
that field. A `PluginSettingsHandle` can call `experimental_set` to validate
and persist its own fields, receive the effective values, fire `onChange`, and
notify settings consumers just like a settings route or `bb plugin config`
write.

**Audit before stabilizing.**

- Confirm synchronous, non-transforming validation remains sufficient.
- Decide whether settings errors need structured issue paths in addition to
  the first user-facing message.
- Confirm schemas should continue running for defaults at registration.
- Exercise concurrent route, CLI, and plugin-owned writes, including secret
  values and unsets, before stabilizing `experimental_set`.
- Decide whether schemas and server-side writes stabilize independently.

## `PluginSettingDescriptor` type `"number"`

**What it does.** A numeric setting descriptor gives server code, provider
configuration, and plugin UI a finite `number` instead of making each consumer
parse a string. The host renders a number input and converts CLI values before
validation. `experimental_schema` can enforce integer and range constraints.
Stored numeric strings from settings created before this descriptor existed
are read as numbers so migrated plugins preserve their configuration.

**Audit before stabilizing.**

- Decide whether common minimum, maximum, and step metadata belongs directly
  on the descriptor instead of only in `experimental_schema`.
- Confirm clearing a number input should continue to unset the stored value.
- Decide how long legacy stored numeric strings should be coerced on read.
- Exercise decimal and exponent input across browser engines and the CLI.

## `bb.experimental_hooks` (`on`, `recheck`)

**What it does.** The one plugin surface that _decides_ rather than observes.
`bb.experimental_hooks.on(hook, handler)` registers this plugin's answer to a
hook — a question core stops to ask and then acts on the answer to. Its
counterpart is `bb.events.on`, whose handlers are told what already happened
and whose return value is ignored; the split is the one git draws between
pre-commit and post-commit hooks, and it is why the two are separate
namespaces rather than one `on`.

One hook today. `"message.dispatch"` is THE admission checkpoint: it runs
before every message reaches a provider — a thread's first message, a
follow-up, a steer, a drained queue row, a retry of a failed turn — and it runs
identically for all of them. The handler receives a typed context (project,
environment/host, prompt blocks plus a plain-text view, the resolved execution
tuple with per-field provenance, origin/parent provenance, the target thread,
whether the attempt would `start-turn` or `join-turn`, and the queued row when
the attempt is a re-attempt) and answers `proceed`, `wait` (queue the message as
a row with a reason and an optional `sendAt`), or `reject` (a synchronous 409
carrying the plugin's message). A handler cannot rewrite the dispatch it is
deciding about: there is no amendment arm.

Handlers run as a deterministic chain in plugin install order, `reject`
short-circuits, `wait` decisions collect across a full pass, and the FIRST
waiter owns the row while the rest have their reasons appended to it. The whole
pass runs under a single server-wide async lock. A handler that throws or
exceeds a 10s decision box fails the attempt with the plugin named
(fail-closed, the `deriveProviderOptions` precedent).

`bb.experimental_hooks.recheck("message.dispatch")` is the second member and the pair to
`on`: `on` answers the question core asks, `recheck` asks core to ask it
again. It schedules a walk that re-attempts every plugin-queued row in queue
order — claim-CAS exactly-once, full hook pass per row, still-blocked rows
re-queue, the per-thread re-queue pacing bounding the churn — and bursts
coalesce into one walk. It resolves when the walk is SCHEDULED, not when it
finishes: the walk has no caller to report to (a failed re-attempt lands on its
row, like the due sweep's), and resolving on completion would mean awaiting a
full hook pass from inside whatever asked, which for a handler holding the
evaluation lock could never complete.

The split it draws: **core owns the re-draining and the clock; plugins own
every other wait condition and tell core when to re-ask.** Core's own wakes are
the `sendAt` due sweep, thread-idle, workspace-ready, interaction-settled,
send-now and the orphan sweep — all of them queue mechanics or core waits.
Capacity is not one of them: `concurrency-limit` subscribes to
`thread.idle`/`thread.failed`/`thread.archived`/`thread.deleted` and calls
`recheck("message.dispatch")` itself. That retires the future `clearWait` need for
external-event waits: a plugin does not release a row, it wakes core and core
re-asks, so a wake that was not warranted is safe by construction.

A plugin's wait therefore clears when the row's `sendAt` comes due, when some
plugin requests a drain and this handler now proceeds, when the user sends it
now, or when the orphan sweep clears a wait whose plugin is no longer running.

**Audit before stabilizing.**

- **One hook is not a shape.** The registry, the map and the `on(hook, handler)`
  signature are all built for several hooks, and there is one. Confirm the
  second hook fits the shape before stabilizing it — or collapse the argument.
- **`wait` returns no row id.** A handler returns a reason; the id arrives later
  on `message.queued`. Every plugin that must act on its own wait therefore
  correlates by ordering or re-queries `threads.queue.list({ waitHolder })`.
  Decide whether the decision should be able to name a correlation key.
- **A wait has no plugin-driven release, only a plugin-driven re-ask.**
  `recheck("message.dispatch")` names no row, so a plugin whose one condition resolved wakes
  every plugin-queued row in the server and every handler re-decides. That is
  what makes an unwarranted wake safe, and it is also its cost. Confirm the
  whole-queue walk is still right when there are many plugin waits and many
  waiters, and decide then whether a scoped variant is worth the correlation
  problem it reintroduces (see the row-id bullet above).
- **`recheck("message.dispatch")` is unauthenticated in both directions.** Any plugin can
  wake rows held by any other, and core does not tell a handler why it is being
  re-asked. Both are deliberate — a wait is a decision, not a lease — but
  confirm before stabilizing that no plugin needs to distinguish "core's clock"
  from "somebody asked".
- **Resolving on schedule is a contract, not an implementation detail.** A
  caller cannot await the walk, so it cannot observe whether its own row went.
  Confirm the alternative (resolve on completion, with the lock-reentrancy
  hazard) is genuinely unwanted rather than merely unbuilt.
- **A handler's `sendAt` and a user's `--send-at` are the same column.** A
  plugin wait with a `sendAt` sets the row's `sendAt`, which is also what
  `--send-at` sets. Confirm nothing renders a plugin's instant as a user's
  schedule.
- **Send-now bypasses EVERY plugin check.** A user's "Send now" skips the pass
  entirely, so a content-policy `reject` is skipped with it. That is a
  deliberate loosening of the old skip-owner-only rule; confirm it before
  stabilizing, or split `wait` bypass from `reject` bypass.
- **"Never started" is now a thread status, not an event-log fact.** That
  replaced a `getLastProviderThreadId(...) === null` probe on a hot-ish path.
  Confirm `pending` is maintained everywhere that probe used to be consulted.
- **The context DTOs.** `thread`, `project`, `environment`, `host` and
  `queuedMessage` are public DTOs; confirm they are what a plugin should couple
  to.
- **The single server-wide lock.** One slow handler delays every dispatch in the
  server, up to its box.

## `interaction.pending` (`bb.events.on`)

**What it does.** This announcement fires after core commits a pending
interaction row. It carries the public thread and pending interaction DTOs.
Plugins can react without delaying or changing the interaction.

**Audit before stabilizing.** Confirm that all plugins should receive provider
and plugin interaction details. Confirm that the full interaction DTO remains
the correct payload instead of an id that requires a fresh SDK read. Decide
whether this event needs matching resolved, cancelled, or interrupted events.

## `message.queued` / `message.dispatched` / `turn.failed` (`bb.events.on`)

**What it does.** Three announcements on the observe-only `bb.events.on`
registry.

`message.queued` and `message.dispatched` each carry the `ThreadQueuedMessage`
DTO that `GET /threads/:id/queued-messages` serves. `message.queued` fires when
a row's wait is rewritten as well as when the row is first queued, because a row
that moved from one wait to another is news to whoever was waiting on the old
one.

`turn.failed` fires after a turn failed and the thread has landed in `error`. It
carries ids and failure facts only — `threadId`, the failed turn's `requestId`,
the provider `turnId`, the provider's `ProviderErrorInfo`, the latest
`ProviderRateLimitState` and `attemptNumber` — and no thread DTO or copy of the
message, because a retry is asked for by reference with
`bb.sdk.threads.retry({ threadId, turnRequestId, sendAt })` and anything else is
one `threads.get` away and fresher for being read when it is used. It is an
announcement, not a question: the failure stands as core applied it, a handler's
return value is ignored, and a handler that throws is isolated like any other
event handler. A broken retry plugin can therefore cost a retry; it can never
make failures unrecoverable.

**Audit before stabilizing.** These are still the only non-thread events on
`bb.events.on`, so the interface is called `PluginThreadEventPayloads` and its
handler type `PluginThreadEventHandler`; renaming both project-wide is part of
stabilizing. Decide whether every plugin should see every queued row (it does
today, and filtering on `entry.waitingOn` is the documented pattern) or whether
a plugin should only see the rows whose wait it owns. Decide too whether
`message.queued` firing on every rewritten wait is what a listener wants, or
whether a separate `message.updated` belongs alongside it — the timeline event
already distinguishes the two. There is no cancellation event: a plugin that
needs a teardown signal has none today, so decide whether one belongs here
before this is stable. For `turn.failed`, confirm the payload answers every
question a retry policy asks without replaying the event log, and note that
attempt caps are entirely the plugin's: core enforces no ceiling on retry chains
beyond one live retry row per original request.

## `bb.branding.experimental_icons` (manifest) and namespaced presentation glyphs

**What it does.** A plugin ships SVG files and declares a name → file map in
its `package.json` manifest: `"bb": { "branding": { "experimental_icons": {
"receipt": "./icons/receipt.svg" } } }`. Timeline row presentation
(`presentation.icon.glyph`, including `bb.agents.registerTool` presentation)
and provider branding (`bb.providers.register({ icon })`) may then reference
an entry by the namespaced glyph `"<pluginId>/<name>"`. The server validates
the map at build and at load (name grammar, `./` path ending in `.svg` inside
the plugin root, 32 KiB per file, 64 entries, a reject-only SVG validator that
refuses a doctype or processing instruction, `script`, `handler`, `listener`,
`iframe`, `foreignObject`, `image`, `video`, `audio`, `a` and `style`
elements, any element outside the SVG namespace, `on*` attributes, any
`href`/`xlink:href` that is not a same-document `#` reference, any attribute
value carrying a CSS escape or an external `url()`/`src()`/`image()`/
`image-set()`, a SMIL `attributeName` naming an `on*` handler or an `href`,
and `xml:base`), serves the bytes from the installed plugin directory at
`/api/v1/plugins/<id>/assets/icons/<name>.svg?h=<hash>` with immutable
caching, and rejects at ingest (`provider/unhandled`, reason naming the glyph)
a namespaced glyph that is not the emitting plugin's own declared icon. The
emitting plugin is the thread's provider plugin, except for a `server: "bb"`
tool row: the bridge stamps the presentation the server resolved from the
plugin that registered the tool, so that row's glyph is checked against the
tool's plugin (it passes when the tool is still registered by the plugin the
glyph names with exactly that icon). Web
and mobile resolve the glyph against the plugin inventory (`icons` on the
installed-plugin shape) and draw the SVG tinted with `currentColor`; if the
plugin is gone or the name unknown at render time the per-kind fallback glyph
renders. The conformance kit's `presentation/icon-namespaced-declared` rule
(fixture `icons: { pluginId, names }`) catches a bad glyph before a bridge
ships.

`bb.branding.icon` refuses the namespaced form outright (the manifest
schema fails the build and the load, naming the value): it is the plugin's
own mark, read by every client as a host glyph name or a hashed compact-SVG
URL, so a self-reference would only restate a path already in the map while
every tool without a `presentation.icon` inherited a glyph ingest rejects.

**Audit before stabilizing.** Decide whether the key is `icons` outright
(the strict manifest schema makes the rename breaking, so the stabilization
release must accept both for one release). Decide whether `bb.branding.icon`
should instead resolve a self-referencing namespaced glyph through the map
(the refusal is the smaller, reversible choice). The SVG rules are three.
A declared icon passes the strict set above at build and at load.
`bb.branding.icon` (and a marketplace catalog icon) passes the
document-shape check it always had — UTF-8, no doctype or processing
instruction, well-formed XML, an `<svg>` root — at build and at load. An SVG
`bb.branding.logo.light`/`.dark` is checked at `bb plugin build` only, and
only for script vectors: a `script`, `handler` or `listener` element in any
namespace, an `on*` attribute, or an `href`/`xlink:href` whose scheme is
`javascript:`. Nothing else, so an Illustrator `<!DOCTYPE svg PUBLIC …>`,
`<switch><foreignObject requiredExtensions=…>` and `<metadata><sfw …>`,
Inkscape `<sodipodi:namedview>` and `<rdf:RDF>`, an `<image
href="data:…">`, an `<a>`-wrapped logo and Latin-1 bytes all build. Install
and load never refuse a logo or a path-shaped provider icon: the manifest
reader, the served snapshot and the `bb.providers.register` call take the
bytes as declared, so no installed plugin's tool-export artwork fails its
load (a provider icon is named only in code, so `bb plugin build` cannot
reach it either). What keeps every such document inert is the response: the
branding route (`/plugins/:id/assets/{icon,logo,logo-dark}`), the
declared-icon route and the provider logo route
(`/system/providers/:id/logo`) all carry `x-content-type-options: nosniff`
and `content-security-policy: default-src 'none'; style-src
'unsafe-inline'`, under which no script, handler, `javascript:` URL or
external load runs when the file is opened directly. **Open question for a
major release:** whether to tighten logos and provider icons at install and
load (to the build rules, or to the full declared-icon rules). Either fails
installed plugins whose artwork is an ordinary tool export, so it needs an
audit of installed marketplace and third-party logos and a migration window
first.
Decide whether a full-colour mode (`{ path, mode }`
values) is wanted; today every value is a string and every icon is a
monochrome mask. Decide whether `toolUse` approval presentations are checked
at ingest too (today only timeline rows are; approvals are ephemeral and both
clients fall back). Settle whether a row persisted with a namespaced glyph
should ever be rewritten when the plugin renames or removes the icon; today
rows are never rewritten and simply fall back.

## `experimental_buildBridgeToolCallContent`

**Kept experimental (2026-08-22).** it still accepts two input shapes (ordered `contentBlocks` and the legacy aggregate `{ content, images }`) though every first-party caller now passes the ordered form, and no image MIME/size policy exists at the server boundary; drop the legacy input and settle the policy, then stabilize.

**What it does.** Converts a decoded bb tool-call response into the ordered
text and inline-image content blocks accepted by MCP and Pi tool result
contracts. It preserves a legacy aggregate text/images input while first-party
bridges migrate to ordered `contentBlocks`.

**Audit before stabilizing.** Confirm that MCP and Pi continue sharing this
content-block vocabulary; decide whether legacy aggregate fields still need to
be accepted; and define any image MIME validation, decoding, or payload-size
policy at the server boundary before making the helper stable.

## The ACP bridge kit (`@get-bb/plugin-sdk/provider-bridge/acp`)

**Kept experimental (2026-08-22).** Four members remain, each with an open
question below; the fourteen exports no plugin consumed (the dialect
registry and ids, the raw line handler, the protocol constants, the launch
profile and the model-catalog helpers) left the public surface in the
stabilization audit — the kit grows with a consumer, not ahead of one.

**What it does.** Publishes bb's generic Agent Client Protocol bridge so any
plugin can add an ACP agent without bb-side code. `experimental_acpProviderBridge`
is the bridge a plugin re-exports from its `bb.host` artifact; the agent to
launch arrives per command in `providerOptions.acpLaunchSpec`, so one
implementation serves every agent. The bridge ships three dialects
(`generic`, `cursor`, `grok`) — version 1 of the protocol has no sub-agent
concept and standardizes nothing about `rawInput`, so each agent's vendor
side channels are read by a small module named by id in the registration's
bridge options (`acpDialect`). `experimental_probeAcpAgent` asks one
installed agent what it supports (`initialize` → `agentCapabilities`) so a
plugin can replace a declared guess with the agent's own answer, and
`experimental_acpAgentProbeSchema` validates that answer across a host RPC
boundary. `experimental_acpLaunchSpecSchema` (and its `AcpLaunchSpec` type)
is the launch spec the bridge parses, published so a plugin validates what
it declares against exactly what the bridge will accept; the ACP package
owns the definition (it is no longer a host-daemon-contract shape).

**Audit before stabilizing.** Decide what `probeAcpAgent` owes a caller:
today it spawns the agent with a 10s timeout, advertises the bridge's own
client capabilities, and answers `-32601` to anything the agent asks — settle
whether the timeout, the client capabilities and the refusal are the caller's
to choose. Decide whether `AcpDialect` is the right shape for a third-party
agent before a dialect registry becomes public again — today it has four
optional hooks (`toolIdentity`, `classifyToolCall`, `handleClientRequest`,
`maintenance`) and no versioning, so adding a fifth is a silent capability
change for every dialect; and whether a dialect should be named by value in
the provider registration instead of by id. Settle whether the bridge itself
should be a factory rather than a module singleton before a host artifact
ever needs two configured differently. For `acpLaunchSpecSchema`: the shape
is stored in the ACP plugin's `customAgents` setting and in registrations'
bridge options, so a change is a migration of stored agents — decide what a
plugin is owed when the spec grows a field.

## `PluginProviderDeclaration.experimental_nativeSkillRoots`

**Kept experimental (2026-08-22).** every first-party provider declares it now (stabilization S5 moved the daemon's per-provider scan table here), but no third-party agent has validated the relative-path / 32-root rule or the per-root options, and the split between a global declaration and the per-workspace resolver (`experimental_resolvesNativeRoots`) is one release old.

**What it does.** Names the directories a provider's own agent reads skills
from, relative to the target host's home directory (`user`) or to the
workspace (`project`). bb lists those skills beside its own and offers them in
the composer. It replaces the one thing the server used to dig out of an ACP
agent's launch spec: before the ACP tier was deleted, `GET /projects/:id/
commands` read `acpLaunchSpec.nativeSkillRoots` out of a config record. A
provider's skill layout is the provider's own fact, so it is declared, and
core never reaches into a plugin's opaque bridge options for it. Validated at
registration: `user` and `project` are relative paths only, no dot segments,
no duplicates, at most 32 roots per side. The declaration is global; a
directory only one host can name is the resolver's answer
(`experimental_resolvesNativeRoots`), and bb scans each absolute path once
across the declared and resolved roots, the first in declaration order
winning ([provider-plugin-api.md](provider-plugin-api.md) §1).

**Closed (2026-08-22).** The `absolute` side is gone. Protocol 157 added it
for the pi plugin, which probed every connected host for the skills
directories pi's `settings.json` names and re-registered the union across
hosts — so a host-specific root reached every host's listing and a
project-scoped setting could not be declared at all. Pi now resolves those
directories per host through `experimental_resolvesNativeRoots` like every
other first-party plugin, nothing populated the side, and protocol 163
removed it from the declaration and the daemon wire.

**Audit before stabilizing.** Decide whether the two-bucket shape (`user`,
`project`) is the right vocabulary or whether a root should name its own base
explicitly; confirm the 32-root cap and the relative-path rule against a real
third-party agent; and decide whether this belongs on the declaration at all
or should be reported per host by the bridge, since where an agent keeps its
skills can differ per machine (today that difference is the resolver's job).
The per-root options and the symlink boundary rule are in
[provider-plugin-api.md](provider-plugin-api.md) §1 (the
`experimental_nativeSkillRoots` paragraph); audit whether those options are
the right vocabulary or whether a root should carry a shape like the
resolver's answer does.

## `PluginProviderDeclaration.experimental_nativeCommandRoots`

**What it does.** Names the directories a provider's agent reads its own
slash commands from — flat directories of `*.md` prompt files, Claude Code's
`.claude/commands` — in the same two-sided shape and with the same per-root
options as `experimental_nativeSkillRoots`. bb offers the commands in the
composer beside the agent's skills. Added by stabilization S5 when the
daemon's per-provider scan table was deleted: the claude-code plugin is the
only first-party declarer.

**Audit before stabilizing.** Decide whether commands and skills should stay
two declarations or become one list of typed roots; confirm that a flat
`*.md` directory is the only command layout a third-party agent needs.

## `PluginProviderDeclaration.experimental_resolvesNativeRoots`

**What it does.** Declares that the plugin's `bb.host` entry implements
`experimental_nativeRootsHostContract`. When bb lists a provider's commands or
skills it calls `resolveNativeRoots({ providerId, cwd })` on the workspace
host (cached for ten seconds per plugin, provider, host and workspace;
invalidated when the plugin's settings change or the provider re-registers)
and scans the answer beside the declared roots. This is where host-only
knowledge goes — a config-moved directory, installed vendor plugins,
config-file skill entries — including project-scoped entries a global
declaration cannot carry. A failed or malformed answer is logged and yields
no resolved roots; it never fails the listing.

**Closed (2026-08-22).** Pi's per-host probe converged on this RPC: the pi
plugin's host entry answers `resolveNativeRoots` with the directories its
`settings.json` names on that host, and the declaration's `absolute` side
that carried the probe's union is deleted (protocol 163). Every first-party
plugin with host-only roots now resolves them this way.

**Audit before stabilizing.** Decide whether the flag should exist at all or
whether the server should detect the method on the host entry; and settle
the cache TTL and the invalidation set against a real multi-host setup.

## `experimental_nativeRootsHostContract` (`@get-bb/plugin-sdk/host`)

**What it does.** The one-method RPC contract (`resolveNativeRoots`) a
provider plugin's host entry serves when its declaration sets
`experimental_resolvesNativeRoots`. Input `{ providerId, cwd: string | null }`;
output `{ skills, commands }`, each a list of host-absolute roots with
`origin` (`user` | `project`), `recursive`, `ancestors` (project roots inside
the workspace only), `namePrefix`, and a `shape` (`skills`, `skill`,
`skill-file`, `commands`, `command-file`) that tells the daemon how to read
the root. The contract fills the option defaults.

**Audit before stabilizing.** Confirm the shape vocabulary covers a
third-party agent's layouts; decide whether the contract should accept a
relative path the daemon resolves (so a plugin need not know the host home)
and whether the 256-root cap per side is right.

## `experimental_filterResolvedNativeRoots` (`@get-bb/plugin-sdk/host`)

**What it does.** Checks a `resolveNativeRoots` answer root by root against
the contract (path, origin, name prefix, the manifest marker's form, shape,
the per-side cap of 256), drops a root that fails with a warning naming the
path and the reason, and truncates a side past the cap with one warning. A
resolver calls it before it answers, so one vendor plugin with an odd
manifest name cannot void the whole listing for the cache window; the server
boundary stays strict. A dropped root's reason names its malformed fields
when any field is malformed; the cross-field rules (ancestors on a user root,
a marker on a non-skills shape, a fallback name on a non-skill-file shape)
are judged only on a root whose fields all parse. Added by stabilization S6
after the S5 review.

**Audit before stabilizing.** Decide whether the per-root leniency belongs in
the contract's output schema itself (drop at the boundary, report the drops
in the answer) so a plugin cannot forget to call the helper, and whether
`dropped[].reason` is a contract a resolver's test may pin or free text for
the log.

## Vendor plugin roots (`experimental_resolveClaudePluginRoots` and `experimental_resolveVendorPluginRoots`, `@get-bb/plugin-sdk/host`)

**What it does.** The two readers a provider plugin's `resolveNativeRoots`
handler calls for the vendor plugins installed on the host.
`experimental_resolveVendorPluginRoots({ plugins, layout })` walks plugin
directories and answers the roots with `namePrefix: "<plugin>:"`; every
caller names the layout. `layout: "claude"` is the Claude plugin layout — per
plugin its root `SKILL.md` (named after the plugin when the file's
frontmatter has no name), `skills/`, `commands/`, then the manifest's
`skills` and `commands` entries (a `SKILL.md` file is one skill, a directory
holding `SKILL.md` is one skill, any other directory holds skills; a `.md`
file is one command, a directory holds commands; an absolute or escaping
entry is ignored). `layout: "grok"` lists the manifest's entries only, each
directory recursive. `experimental_resolveClaudePluginRoots({
cwd, homeDir, env })` reads Claude Code's registry first — installs from
`<claudeDir>/plugins/installed_plugins.json` (a `managed` or `user` install
is a user root; `project` and `local` count only for the workspace that
holds them, as project roots; an install path that is gone falls back to the
cache entry for the recorded commit, else the newest), enablement from the
user, project and local `enabledPlugins` settings with the manifest's
`defaultEnabled` for an unlisted plugin, and plugins dropped into the project
and user `skills` directories — and runs the walk over them; the answer also
carries `claudeDir` (`CLAUDE_CONFIG_DIR` or `~/.claude`) so a caller that
lists that directory's own `skills` and `commands` agrees with the reader.
The claude-code plugin answers both sides from it; the ACP plugin's omp and
grok resolvers take `.skills`; the codex plugin feeds its own enabled plugins
(from `config.toml` and the cache) into the walk.

Two rules every caller now shares. Symlinks: a user-origin plugin's skill
components are followed (a personal install commonly links a skill), a
project-origin plugin's are not (checked-in content must not reach outside
the repository), and command components never follow a link. Repeated
paths: within an answer a path appears once per side; the first root to
claim it, in answer order (plugins in the order given, each plugin's roots
in the order above), is kept and a later one is dropped. The contract accepts
a resolved answer that repeats a path and the daemon scans the first root per
path, so a reader that answered the same install twice (the same plugin
recorded under two scopes at one path) listed it once either way; the rule
makes the answer say what the daemon scans. A caller that takes `.skills`
only (omp, grok) still pays the reader's stat of each plugin's `commands/`
and manifest `commands` entries — accepted: a few stats per plugin per
listing, against a second option on the reader.

**Audit before stabilizing.** Decide whether the walk should keep taking a
layout name (`claude`, `grok`, each caller naming its own) or the two facts
behind it (conventional roots on or off, directories recursive or flat) once
a third vendor layout appears; whether `claudeDir` belongs on the answer or
the reader should also answer the config directory's own roots; whether a
skills-only caller should be able to ask for one side; whether the
repeated-path rule should be the contract's (drop at the boundary, first
root wins) rather than each helper's; and whether a plugin's `name` should
be validated as a name prefix here instead of at
`experimental_filterResolvedNativeRoots`.

## `PluginSettingDescriptor.experimental_multiline`

**What it does.** A `type: "string"` setting descriptor field
(`bb.settings.define`). When `true`, the host renders the setting as a
multi-line text field instead of a one-line input: on the web a monospace
textarea below the label and description at the row's full width (six rows
minimum, growing with its content to twenty-four, then scrolling; spellcheck
off), on mobile a monospace multi-line `TextInput`. The stored value is the
same string as before — the flag changes the editor, not the contract, so the
CLI (`bb plugin config <id> set <key> <value>`) and `settings.get()` are
unaffected and a plugin still parses the text itself (the ACP plugin's
`customAgents` JSON array, the first consumer, parses on read and warns). A
descriptor that sets it beside `secret: true` is refused at define time:
secrets are edited in a password field and never echoed back. The field
travels in the settings view (`GET /plugins/:id/settings`), whose clients
parse descriptors with a strict schema; the web and mobile apps ship with
the server, so no client older than this field is served.

**Audit before stabilizing.**

1. **Name and shape.** Decide whether to stabilize as a boolean `multiline`
   or replace it with a `json` descriptor type that validates at the boundary
   (pretty-printing, parse errors shown in the form, a typed value from
   `settings.get()`), which would make this flag redundant for its first
   consumer. A `multiline` boolean still has a use for plain lists, so the two
   may coexist.
2. **Mobile.** Confirm that phones need the editor at all — a JSON array is
   hard to type on a soft keyboard — or whether the mobile form should show
   the value read-only with a "edit on desktop" note.
3. **Unknown descriptor fields.** The strict client schema turns every new
   presentation hint into a client release. Decide whether descriptor schemas
   should tolerate unknown fields so a hint degrades to the one-line input on
   an older client instead of failing the whole settings view.

## `bb.server.experimental_dataDir`

**Kept experimental (2026-08-22).** a sunset member: its only consumer is the ACP plugin's reader of the deprecated `customAcpAgents` array, and it is deleted with that window (`LEGACY_CUSTOM_AGENTS_REMOVED_IN`). A bare data-directory path does not stabilize.

**What it does.** The server's data directory — the one holding `config.json`,
`bb.db` and `plugins/<id>/`. Added because a plugin cannot compute it: a dev
server derives its data dir from its repo root and instance id
(`~/.bb-dev/<instance>`), so the ACP plugin's own `~/.bb` fallback made a dev
server read the production `config.json` while the server read another one.
Its only consumer is that plugin's read of the deprecated `customAcpAgents`
array.

**Audit before stabilizing.** Its one caller dies with the `customAcpAgents`
deprecation window, so decide then whether anything else needs it. If it
stays, decide whether a bare path is the right shape or whether a plugin
should get named, read-only accessors for the bb-managed files it may read —
a path invites writes into bb's directory, which `bb.storage` exists to
prevent.

## `bb.server.experimental_appUrl`

**What it does.** This value gives plugins the operator-configured public app
URL from `BB_APP_URL`. It is `null` when the operator did not configure that
value. Plugins can read it before the server starts to listen.

**Audit before stabilizing.** Decide whether `BB_EXTERNAL_URL` or the bb
connect URL should supply this value when `BB_APP_URL` is empty. Confirm that
one public URL has clear behavior when a server has several access paths.

## Bridge record mode (`experimental_recordProviderChildIo` and `experimental_isProviderBridgeRecording`)

**Kept experimental (2026-08-22).** the recording entry shape is now consumed by the public testing kit, so it is a de-facto fixture format that must be frozen together with `experimental_readBridgeRecording` / `replayRecording`; the `{ threadId | null }` scope is untested against a multiplexing bridge.

**What it does.** `experimental_recordProviderChildIo` tees a provider
child's stdio into the bridge record mode (`BB_PROVIDER_BRIDGE_RECORD_DIR`),
scoped to the bb thread the child serves. It is a no-op when record mode is
off, so a bridge calls it unconditionally after `spawn()`.
`experimental_isProviderBridgeRecording` reports whether record mode is on,
for a bridge whose provider pipe is owned by an SDK and must take the spawn
over to tee it. See [provider-bridge-protocol.md](provider-bridge-protocol.md),
"Record mode".

**Audit before stabilizing.** Decide whether the bridge kit should own the
spawn itself (one helper that spawns and records) instead of a post-spawn
hook; confirm the `{ threadId | null }` scope is the right key once bridges
multiplex several threads over one child; and settle the recording entry
shape (`{ ts, run, seq, dir, line }`) as a documented fixture format.

## `experimental_BridgeRecoveryError`

**Kept experimental (2026-08-22).** it is part of the provider-bridge authoring surface and stabilizes together with `experimental_defineProviderBridge` / `experimental_apiVersion` in the later bridge-kit audit.

**What it does.** A request handler throws it to reject the request with a
typed recovery hint: `runBridgeRequest` answers with the given JSON-RPC
`code` and `error.data.recovery { kind, message, retryable }`, the same way a
`ProviderRequestDecodeError` becomes `INVALID_PARAMS`. A handler that answers
by hand passes the hint to `sendError(id, code, message, { recovery })`
instead. The runtime reads the hint from the rejected request
(`JsonRpcResponseError.recovery`) and acts on the kind; see
[provider-bridge-protocol.md](provider-bridge-protocol.md), "Recovery hints".

**Audit before stabilizing.** Confirm the five kinds cover what third-party
bridges need to say about a rejection (a `notInstalled`/`needsUpdate` kind
for installation was deliberately left to `provider/installation/*`). Decide
whether `retryable` should be per kind (only `sessionArchived` and
`rateLimited` read it today) and whether the runtime should bound the
`rateLimited` ladder from the hint rather than from a constant.

## Provider maintenance toolkit (`experimental_resolveExecutablePath`, `experimental_readCliVersion`, `experimental_commandOutput`, `experimental_versionFrom`, `experimental_compareVersions`, `experimental_formatCommand`, `experimental_npmCommand`, `experimental_npmGlobalInstallCommand`, `experimental_npmLatestVersion`, `experimental_probeNpmGlobalPackage`, `experimental_npmGlobalInstallSource`, `experimental_installationVerification`, `experimental_downloadedInstallerCommand`, `experimental_clampPercent`) (`@get-bb/plugin-sdk/provider-bridge`)

**What it does.** The host-local probes and install-action plumbing behind a
bridge's `provider/health`, `provider/usage` and `provider/installation/*`
answers when its provider is a user-installed CLI. The probes:
`experimental_resolveExecutablePath` (the command's absolute path — the path
itself when given absolute and executable, else the first `which`/`where`
hit, null when absent; 5 s), `experimental_readCliVersion` (`<command>
--version`, the first `x.y.z[-pre]` on stdout or stderr; 5 s),
`experimental_commandOutput` (any command's trimmed stdout+stderr or null on
failure; 15 s), `experimental_versionFrom` (the first version token in a
banner), `experimental_npmLatestVersion` (`npm view <package> version`) and
`experimental_probeNpmGlobalPackage` (`npm prefix -g` as the global bin
directory plus `npm list -g <package>` as the installed version). The
decisions: `experimental_compareVersions` (numeric core, then a prerelease
below its release), `experimental_npmGlobalInstallSource` (`npmGlobal` when
the executable sits inside npm's global bin, `external` otherwise,
`notInstalled` when absent) and `experimental_installationVerification` (an
install verifies by existence; an update by reaching the latest version the
status saw, or by any change when the registry was unreachable). The
actions: `experimental_npmGlobalInstallCommand` (`npm install -g
<package>@latest` with its display string), `experimental_downloadedInstallerCommand`
(a vendor's `curl | bash` script run from a temp file),
`experimental_npmCommand` (`npm` / `npm.cmd`) and
`experimental_formatCommand` (a display command line with shell-unsafe
arguments single-quoted). `experimental_clampPercent` rounds a usage
percentage into 0–100. The codex, claude-code and pi bridges and the ACP kit
build their maintenance answers from these; each keeps its own policy (the
minimum supported version, the login command, credential and usage readers,
dist-tag and `doctor` parsing) beside them.

**Audit before stabilizing.**

1. **Timeouts are fixed.** 5 s for `which`/`--version`, 15 s for npm and
   self-diagnostics; a bridge whose CLI is slow to start (a JVM, a first-run
   download) cannot lengthen them. Decide whether the budgets become
   arguments before the signatures are a promise.
2. **`compareVersions` is semver-shaped, not semver.** Build metadata and
   four-part versions read as `0.0.0`; prereleases compare by locale string.
   Decide whether a real semver parser is owed.
3. **The npm helpers assume a global install.** `probeNpmGlobalPackage` and
   `npmGlobalInstallSource` model one layout (npm's global prefix); pnpm,
   volta and corepack shims read as `external`. Decide whether the source
   enum should grow before it is relied on.
4. **`downloadedInstallerCommand` is POSIX.** `sh -c` with `mktemp`, `curl`
   and `bash`; there is no Windows form. Decide whether it should refuse on
   win32 rather than hand the daemon a command that cannot run.

## Presentation builders (`experimental_presentationTitle`, `experimental_presentationDetail`, `experimental_withTitle`, `experimental_presentationFileName`, `experimental_COMPACTION_PRESENTATION`, `experimental_REASONING_PRESENTATION`, `experimental_fileReadPresentation`, `experimental_searchPresentation`, `experimental_webSearchPresentation`, `experimental_webFetchPresentation`, `experimental_planStepsPresentation`, `experimental_toolPresentation`) (`@get-bb/plugin-sdk/provider-bridge`)

**What it does.** The bridge kit's presentation building blocks for the
grammar-v3 `presentation` a bridge stamps on every item it opens
(docs/provider-plugin-api.md §3): `experimental_presentationTitle` takes the
first non-empty line of a text and caps it at 160 characters with an
ellipsis, returning undefined when there is nothing to headline;
`experimental_presentationDetail` caps a row detail at the persisted
schema's 280-character limit (the same constant the server validates with,
so a bridge can never build a detail the ingest rejects);
`experimental_withTitle` stamps a title on a presentation only when there is
one; `experimental_presentationFileName` is the last path segment a file row
headlines with. The two constants are the core-kind rows whose wording is the
same for every provider (compaction: "Compacting context" / "Compacted
context" under `Archive`; reasoning: "Thinking" / "Thought" under `Brain`),
and the five builders are the core shapes whose label and glyph do not depend
on the provider: file read (`FileText`, headlined by file name), search
(`content` → "Searching files" / `Search`, `path` → "Finding files" /
`FolderOpen`), web search (`Globe`, headlined by the query when there is
one), web fetch (`Browser`, headlined by the URL), and a plan-steps snapshot
("Updating plan" / `ListTodo`, collapsed by default, headlined by the active
step). `experimental_toolPresentation` is the generic "Running <tool>" /
"Ran <tool>" row under `Toolbox` for a tool with no kind and no presentation
of its own. The codex, claude-code and ACP bridges and the echo example
build their rows from these and keep only their own vocabulary (which native
tool is which kind, how a command headline is unwrapped, per-tool tables).

**Audit before stabilizing.**

1. **The wording is a product decision.** A third-party bridge that adopts
   the constants inherits bb's English labels and glyph names; a bridge
   that wants its own wording builds the object itself. Decide whether the
   labels should come from the host (localized, themed) rather than be
   persisted from the bridge before the constants are a promise.
2. **The caps are the schema's.** The 160-character headline cap is a kit
   convention, the 280-character detail cap is the persisted schema's;
   stabilizing the helpers freezes both numbers as public behaviour.
3. **Plan-steps rows collapse by default.** `experimental_planStepsPresentation`
   sets `suppress: true` (the todo banner reads the snapshot); codex keeps
   its own uncollapsed variant. Decide which default a third-party bridge
   should get.

## `experimental_readBoundedLines` (`@get-bb/plugin-sdk/provider-bridge`)

**What it does.** The bridge kit's newline-delimited line reader, the one the
daemon reads every bridge's stdout with and the bridge worker reads its stdin
with: LF-only framing (never `readline`, which also splits on U+2028/U+2029
and tears a JSON line that carries them raw), a trailing CR stripped so a
CRLF producer parses, and a hard per-line cap (64 MiB by default) past which
the line is discarded up to its terminator and reported through `onOverflow`
with the byte count, so one runaway message costs its own content and
nothing else. A bridge that supervises a JSON-lines child (pi's `--mode rpc`
stdout and its extension channel) reads it with this instead of carrying
its own copy. The optional `onClose` fires once the input ends; a final
unterminated line is emitted before it.

**Audit before stabilizing.**

1. **The default cap is the wire's.** `maxLineBytes` defaults to the JSON-RPC
   line bound the runtime applies to the bridge itself; a provider child's
   payloads may deserve a different bound. Decide whether the default should
   be an explicit argument for child pipes.
2. **`onOverflow` is required.** The daemon logs the drop; a bridge might
   reasonably want to fail the session instead. Decide whether the reader
   should offer a fail-closed mode before the signature is a promise.

## Live-file navigation (`experimental_FileLink`, `BbNavigate.experimental_openFilePreview`, `BbNavigate.experimental_openFileExternally`, and `PluginFileOpenerSource.experimental_hostId`)

**Kept experimental (2026-08-22).** `experimental_hostId` is persisted inside opener-tab `paramsJson` (a rename needs a read-compat shim), Windows/UNC paths were never verified, and `experimental_openFilePreview` has no consumer.

**What it does.** Gives plugin UI explicit, source-safe references to live
workspace, host, and thread-storage files. Ordinary `experimental_FileLink`
activation and the preview method use the current surface's shared file-tab
controller, including extension preferences and plugin file openers. The
external method resolves the current client's preferred file target, absolute
path, local/remote-SSH context, and line/column support. The boolean methods
report host acceptance; later OS failures remain host-owned. The host id added
to file-opener sources preserves explicit host identity when a plugin page
opens a host file without ambient thread context. Valid link targets expose a
scheme-safe href, while traversal paths, ill-formed Unicode, and other
malformed runtime targets remain inert in both the app and SDK test runtime.

**Audit before stabilizing.**

1. Verify strict target/path/location validation on POSIX, Windows drive, and
   UNC paths, including stale environment, host, and thread identities.
2. Confirm preview identity, persistence, opener preference, one-off Open with,
   disabled opener fallback, and explicit-host migration on Thread, New-thread,
   Settings, and plugin-page surfaces.
3. Audit external opening across local and remote clients, disconnected hosts,
   missing preferred apps, and targets with line but not column support.
4. Confirm link anchor behavior, unavailable menu states, copy semantics, and
   whether per-app external choices should remain host-owned menu affordances
   rather than become plugin-selectable API.
5. Measure the lazy boundary: mounting a file link must not start file reads,
   preview imports, editor discovery, or panel-destination loading.
6. Decide whether Git snapshots or deleted working-tree files merit separate
   target variants; do not weaken live-file guarantees to accommodate them.
7. Confirm `PluginFileOpenerSource.experimental_hostId` can become a stable
   required `hostId` field without breaking older opener implementations.

## Host plugin foundation (`bb.hosts.experimental_client`, `ExperimentalHostClient.experimental_onWorkerExit`, `ExperimentalHostClient.experimental_onSignal`, `ExperimentalHostRpcContext.experimental_retainWorker`, `experimental_defineHostEntry`, and `experimental_createHostEntryHarness`)

**Kept experimental (2026-08-22).** signals and watches have no consumer (decide whether to delete them or keep them experimental separately from calls), none of the lifetime/limit numbers has been measured against a plugin other than keep-awake, and the artifact-contract names (`experimental_apiVersion`, `experimental_signals`, the injected context members) are read by the daemon from installed artifacts, so renaming them needs a dual-name window plus a protocol bump.

**What it does.** Lets one plugin package declare a singular `bb.host` Node
entry, share a Standard Schema contract between its server and host entries,
and call methods on an explicit enrolled host. A client may observe unexpected
worker exits and typed, ephemeral host signals. The host context supplies
request and generation abort signals, persistent plugin-scoped data and
worker-scoped temporary directories, daemon-owned native file watches, and
explicit worker-retention leases for independent background work. Calls and
watches retain automatically; otherwise, the daemon gracefully evicts a worker
after five idle minutes and starts it again on the next call. There is no global
worker-count limit.

The single-worker, idle-eviction, retention, and call-timeout rules above are
specific to the host RPC consumer. Other daemon subsystems may attach the same
`bb.host` artifact through a different bootstrap and own their own process
lifecycle.

The initial builtin proof is Keep Awake: it owns a host target, a worker-owned
child process, desired-state reconciliation, and
unexpected-exit recovery without feature-specific core hooks.

**Audit before stabilizing.**

1. **Contract shape.** Confirm Standard Schema values remain the right runtime
   boundary and decide whether method-specific typed errors are necessary.
2. **Targeting.** Confirm explicit host ids are enough for V1 and add an
   environment-aware primitive only alongside a plugin that proves its
   locking and workspace semantics.
3. **Process lifetime.** Measure whether five idle minutes is the right timeout,
   whether watches should continue retaining automatically, and whether leases
   acquired only during active handlers are expressive enough. Confirm there is
   no need for manifest lifetime flags, plugin-selected timeouts, a global
   worker limit, or plugin-specific restart policy. Confirm unexpected-exit
   notification is the right generic repair trigger, remains suppressed for
   graceful and idle disposal, and does not create crash loops.
   Verify reconnect generation reconciliation covers disable/uninstall during
   an outage without stopping a still-current worker on every transient drop.
4. **Signals and watches.** Confirm host signals should remain private,
   ephemeral invalidations rather than a durable event log. Audit native-watch
   coalescing, backpressure, rescan/error events, per-worker limits, and cleanup
   against a plugin that watches real workspace state.
5. **Paths.** Confirm the stable host data path layout and generation-temporary
   cleanup behavior across crashes and daemon restarts.
6. **Limits.** Audit the common call duration, startup/cancellation grace, 8
   MiB JSON payload cap, 256 MiB artifact cap, and per-plugin admission limits
   (256 active calls / 32 MiB of active inputs) against real plugins. Confirm
   retaining only the most recently materialized artifact digest per plugin is
   sufficient.
7. **Environment.** Confirm executable discovery through normalized `PATH`
   and stripping all daemon-owned `BB_*` variables.
8. **Trust and dependencies.** V1 host plugins are trusted Node programs that
   may use `child_process`, filesystem, and network APIs. Decide whether later
   permissions, native artifacts, or an explicit dependency installer can be
   layered on without changing the RPC contract. Confirm rejecting all private
   `@bb/*` imports from host bundles is the correct permanent boundary, and
   audit the builder-supplied public SDK runtime against future host exports.
9. **Composition boundary.** Confirm host RPC methods and signals should remain
   private to the owning plugin while allowing another daemon subsystem to
   consume the same `bb.host` artifact through its own bootstrap and lifecycle.
10. **Test harness.** Audit both layers: the server harness's
    `experimental_callHostRpc` option, `experimental_hostEntry` option (a
    plugin whose manifest declares no `bb.host` entry, so the fake refuses
    `bb.providers.register` and `experimental_aiServices.register` the way
    production does), `experimental_declaredIconNames` option (the names the
    manifest declares under `bb.branding.experimental_icons`, so the fake
    refuses a provider `icon` or a tool `presentation.icon.glyph` that names
    another plugin's icon or an undeclared one, with production's messages;
    the rule itself, `undeclaredIconProblem`, lives in the SDK's host policy
    and the server applies the same function at register and at ingest),
    `experimental_hostRpcCalls` inspection list, `experimental_emitHostWorkerExit`,
    and `experimental_emitHostSignal` behavior drivers; and the host-entry
    harness's `experimental_call`,
    `experimental_getSignals`, `experimental_getRetainedWorkerLeaseCount`,
    `experimental_lifecycleSignal`, path/watch options, and
    `experimental_dispose`. Confirm the host harness should
    continue simulating validation, cancellation, lifecycle, JSON, and size
    limits without pretending to model process startup, crashes, native watcher
    recovery, or reconnect behavior.

## Fixed-tab targets (`experimental_target`, `experimental_useAppPanel`, and `experimental_useFixedTabTarget`)

**Kept experimental (2026-08-22).** `PluginNavPanelRegistration.fixedTabs` itself is stable (two shipped plugins plus the demo; host persistence tested). The target trio has one example consumer, and items 7–9 below (validator errors, target survival rules, a cross-thread surface) are unanswered.

**What it does.** Lets a nav panel declare ordered, non-closable tabs in the
host-owned right panel. The host owns tab selection, persistence, chrome,
Browser and Terminal tools. One tab is active per visible split pane, so
multiple fixed-tab components can be mounted concurrently; a component mounts
only while active in a visible pane and the panel is open. A fixed tab receives
the nav page's current `subPath`; `layout: "padded"` uses
host padding and scrolling, while `layout: "flush"` gives the component the
whole content region. On the first visit the first declared fixed tab opens on
wide layouts. A later user close remains closed. Every fixed-tab registration
must include a `panelId` matching its containing nav panel and is also its
stable, plugin-owner-and-panel-scoped reference. `experimental_useAppPanel()`
can select one of the calling plugin's eligible tabs on the current surface
and optionally submit a JSON-safe target. The tab's `experimental_target`
validator owns the target type and policy; `experimental_useFixedTabTarget()`
returns the validated current-session value with a sequence and explicit
`clear()`. Tab selection stays durable. Each tab's target remains memory-only,
but survives inactive-tab, closed-panel, and route remounts until its owner
clears it or the app refreshes. Core Changes targets and plugin targets resolve
through the same feature-agnostic controller.

**Public surface.** `ExperimentalFixedTabTargetContract`,
`ExperimentalPluginFixedTabReference` (the stable
`PluginFixedTabRegistration` / `PluginFixedTabDeclaration` carry the
`experimental_target` member through it), `ExperimentalAppPanelSurface`,
`ExperimentalFixedTabTargetState`, `ExperimentalOpenFixedTabOptions`,
`ExperimentalAppPanel`, `experimental_useAppPanel`, and
`experimental_useFixedTabTarget`. The frontend testing runtime mirrors this
with `ExperimentalFixedTabOpenCall`, the
`experimental_openFixedTab`/`experimental_fixedTabTarget` render options, and
the `experimental_fixedTabOpenCalls` inspection list.

**Audit before stabilizing.**

1. Confirm first-visit opening and subsequent close persistence across plugin
   reloads, app upgrades, wide/compact transitions, and page deep links.
2. Exercise multiple fixed tabs and dynamic registration changes; selection
   must remain stable when possible and fall back without mounting components
   that are inactive in every visible pane.
3. Confirm `subPath` is sufficient context and that fixed tabs should remain
   page-scoped rather than gaining independent routes or plugin-owned state.
4. Audit padded versus flush layout against Tasks, Docs, accessibility zoom,
   and nested scrolling before freezing the presentation contract.
5. Confirm named icon hints and the non-closable tab treatment remain the right
   amount of plugin-controlled chrome.
6. Audit registration objects as references: identity is scoped to the mounted
   plugin and current nav panel, with no cross-plugin addressing or global ids.
7. Confirm sync type guards remain the right owner validation contract and
   define error reporting if a validator throws or becomes stale after reload.
8. Exercise repeated equal targets, explicit clearing, crashes, inactive-tab,
   panel, and route remounts, refresh, and compact drawer animation. Targets
   must survive remounts in the current app session, never survive refresh, and
   never reappear after their owner clears them.
9. Decide whether a future cross-thread surface should navigate before opening;
   the initial public surface intentionally supports only `{ kind: "current" }`.
10. Keep core and plugin destinations on the same resolver and verify the
    controller never learns Changes, file, task, or document target shapes.

## `PluginNavPanelRegistration.experimental_sidebarAccessory`

**Kept experimental (2026-08-22).** one consumer (the tasks plugin); item 1 below (a narrower value/badge contract) would change the API shape.

**What it does.** Lets a nav panel register a no-props, presentational React
component at the trailing edge of its host-rendered sidebar row. The component
can own an RPC query and realtime subscription, so a live count updates within
that subtree instead of lifting plugin state into the whole sidebar. The host
does not mount it on compact viewports. On wider viewports its layout box is
limited to one line at 4rem wide by 1.25rem high; overflow is clipped and
ordinary long text is ellipsized. It shares the trailing action column and
fades out for the host options button on row hover or keyboard focus without
unmounting. A crash hides only the accessory.

**Audit before stabilizing.**

1. **Component versus value.** Confirm real consumers need component-owned
   live state, rather than a narrower string/number/badge value plus a separate
   host update primitive. Installed plugins are trusted, but a component can
   still render controls or markup that is inappropriate for row chrome.
2. **Budget.** Revisit the 4rem by 1.25rem cap against counts, short statuses,
   localization, browser zoom, and multiple plugin rows. Decide whether the
   host should expose a fixed badge treatment instead of accepting plugin
   styling.
3. **Compact behavior.** The component is not mounted below the compact
   breakpoint, so it performs no hidden queries there and loses local state
   when the viewport crosses the breakpoint. Confirm that is preferable to a
   mounted-but-CSS-hidden subtree.
4. **Overflow and portals.** The wrapper clips ordinary descendants but cannot
   constrain content portalled elsewhere in the document. Confirm the
   presentational-only contract is sufficient, or enforce a non-component
   value before stabilization.
5. **Accessibility.** Accessory text is exposed beside the navigation button
   without changing that button's stable accessible name. Confirm that reading
   order and the focus-triggered accessory/options swap work for counts and
   short statuses, and decide whether a dedicated label prop or host-rendered
   status semantics are needed.

## `PluginContentScriptContext.experimental_setThreadRowStatus`

**Kept experimental (2026-08-22).** kept: consumed by the collapsed-section
status rollup — `SidebarSectionRow` and `TopLevelSidebarSection` read the
app's thread-row-status store through `usePluginThreadRowStatusForThreads`,
so a hidden thread's plugin status reaches its collapsed section header. The
audit items below are unchanged.

Lets a plugin-lifetime content script set or clear one of its own status
indicators on an explicit thread row. The status survives route changes and is
cleared automatically when that frontend generation deactivates.

Before stabilization, audit:

- whether explicit thread targeting belongs on content-script context or a
  dedicated app-level controller;
- multiple simultaneous runs owned by one plugin on one thread;
- arbitration across plugins, frontend generations, and native thread
  statuses;
- persistence expectations across full app reloads and multiple windows;
- validation, accessibility labels, reduced motion, and cleanup on plugin
  reload/disable/removal;
- the name of `PluginComposerThreadRowStatus.tone`. The field is a state the
  plugin reports (`default | running | success | error`), not a tone: the host
  maps it to both a color and an animation (`running` pulses in the success
  color; `success` and `error` are static; omitted is muted). `state` is the
  candidate rename. Nothing under `plugins/*` sets a status today, so the
  rename is free until the prefix drops.

## `bb.providers.register` (`experimental_bridgeOptions`, `experimental_visibility`, and the `experimental_providerBridge` artifact export)

**Kept experimental (2026-08-22).** `bb.providers.register` and the declaration's target-state fields are stable. `experimental_bridgeOptions` and `experimental_visibility` have one consumer (the ACP plugin); docs/provider-plugin-api.md §1 lists both under "Still experimental on the declaration" — decide whether static options survive beside `deriveProviderOptions` before naming them. The `experimental_providerBridge` export name is an artifact contract read by the daemon bootstrap from every installed plugin; renaming it needs a dual-name acceptance window plus a protocol bump, so it stabilizes with the bridge kit once that deprecation policy exists.

**What it does.** Lets a plugin declare an agent provider into the server's
`ProviderRegistryService`. The declaration owns static metadata and opaque
bridge options; executable behavior is the bridge the plugin exports from its
`bb.host` artifact. Registering without one fails the plugin load. The
declaration is
validated at call time by the shared host policy
(`validatePluginProviderDeclaration`); registrations stage during the factory
and commit when the plugin load commits, are replaced wholesale on reload, and
are removed by the returned disposer or on unload/disable. Declarations are
the ONLY source of providers — the core catalog seed is deleted, so disabling
a provider plugin removes its provider. A registered provider is mapped onto
exactly one client shape, `ProviderInfo`, plus the backend-only
`ProviderServerCapabilities`, and appears in the composed provider listing
(`GET /system/providers` / execution options). `bb.providers` is the namespace
(`bb.agents` keeps `configure`, `registerTool`, `contributeInstructions`).

Ids are flat and first-wins: a live id collision fails the later plugin's
load, and no id is reserved ahead of time (`RESERVED_PROVIDER_ID_OWNERS` is
gone). Listing order is plugin install order — bundled first-party plugins
rank first, in their bundled-list order, then every other plugin by install
time — under the user's `providerOrder` / `defaultProviderId` app settings
(`PRODUCT_PROVIDER_ORDER` and `PRODUCT_DEFAULT_PROVIDER_ID` are gone).
`experimental_visibility: "installed"` withholds a provider from unscoped
listings until its own `provider/health` result is not `not_installed`.
`experimental_bridgeOptions` is validated as bounded JSON, rides every daemon
bridge launch, participates in the runtime process key, and arrives at the
bridge as provider-scoped static options. Core does not interpret its keys.

**Audit before stabilizing.**

1. **Install-order ranking.** Bundled plugins rank by their position in
   `BUNDLED_PLUGINS`; other plugins by `installedAt`. Confirm that a
   reinstalled builtin (tombstone then reinstall) keeping its bundled rank is
   right, and that `installedAt` is the fact users expect for third-party
   order (vs. first-load time). The user overlay (`providerOrder`) is an
   ordered id list that ignores unknown ids; decide whether stale ids should
   be pruned on write.
2. **Icon URL shape.** `icon` uses the `bb.branding.icon` grammar (a named host
   glyph, or a `./`-prefixed plugin-relative SVG) plus the plugin's own
   declared icons as `"<pluginId>/<name>"` (`bb.branding.experimental_icons`;
   a foreign plugin id or an undeclared name is refused at the register
   call). A path, or a declared icon's bytes, is snapshotted at registration
   and served from `/api/v1/system/providers/<id>/logo`; a host glyph name
   yields a null `logoUrl` and no server-side resolution at all. Decide
   whether the host should resolve declared glyph names for providers the way
   it does for plugin branding, and decide the logo route's cache policy,
   before either freezes into clients.
3. **Collision semantics.** Ids are first-come collision-rejected: a staged
   collision fails the whole plugin load; a post-activation registration
   throws to the plugin. With reservation gone, a disabled first-party plugin
   leaves its id claimable by anyone until it is re-enabled (which then fails
   to load). Confirm first-wins is right across plugin load order, and decide
   whether a namespace rule (plugin-scoped id prefixes) is wanted before
   third-party ids proliferate.
4. **Bridge delivery.** A provider bridge is a second consumer of the
   plugin's `bb.host` artifact: it is exported by name
   (`experimental_providerBridge`), built into `dist/host.js`, recorded in the
   one live-host-artifact registry, served by the one host artifact route, and
   cached once per plugin on the daemon. Thread commands carry `bridgeLaunch
{pluginId, source: {kind: "artifact", digest, byteLength}, envPassthrough}`.
   Every provider, first-party or not, arrives as an artifact (there is no
   daemon-bundled bridge since pi moved to its plugin). Before stabilizing:
   confirm one artifact per
   plugin survives (a plugin declaring several providers today ships one bridge
   for all of them, and there is no way to name a second), confirm the
   single-bundle shape survives per-platform needs, and decide whether a
   router-kind declaration — a picker entry resolving to another provider at
   submit time, removed from the contract because nothing ever resolved one —
   returns as its own surface.
5. **What a capability may be.** `supportsHostAiServices` was removed after
   shipping: it declared that bb's voice-transcription and structured-inference
   features could route through the provider, which is a fact about the daemon
   bundle rather than about the provider. `supportsWorkflows` went the same
   way in WS2a: whether a session may use the Workflow tool is the Claude
   plugin's own knob (its `workflowsDisabled` setting, derived into
   `providerOptions`), not a fact core needs. Apply the same test to every
   remaining capability before stabilizing: a declaration may assert what the
   provider itself implements and an external consumer needs pre-session,
   never what bb or its daemon can do with it.
6. **Static bridge options and visibility.** Confirm 64 KiB remains a suitable
   declaration-time limit, that opaque options should continue to be shared by
   every host rather than resolved per host, and whether deep-frozen plain JSON
   is the right stable value contract. Confirm `"always" | "installed"` is
   enough listing policy, that health failure should continue to hide an
   installed-only provider, and that targeted requests may continue resolving
   a registered provider even while discovery says it is absent.

## `@get-bb/plugin-sdk/provider-bridge` (the provider-bridge authoring surface)

**Kept experimental (2026-08-22).** `experimental_defineProviderBridge` / `experimental_apiVersion` are an artifact↔daemon contract (the bootstrap refuses anything but version 1 by name), and the deprecation window between independently-updating artifacts and daemons (item 4) is undecided.

**What it does.** The published module a provider bridge compiles against. A
bridge ships inside its plugin's `bb.host` artifact, and a host artifact may
not import private `@bb/*` workspace packages, so everything a bridge needs is
named here: `experimental_defineProviderBridge` (the export shape the
daemon-side bootstrap looks for), the Provider Bridge Protocol's method
vocabulary, the `thread/delta` grammar, and param schemas, the bridge kit's
authoring helpers (JSON-RPC framing, tool-call and interaction codecs,
visibility, dialect-parsing helpers), and the `@bb/domain` command-plane
vocabulary those params reference.
Curated by hand — named exports only, never `export *`. Unlike
`@get-bb/plugin-sdk` and `@get-bb/plugin-sdk/host`, it is NOT a build-time
runtime stub: it is pure schema and helper code with no daemon-pinned
behavior, so a provider plugin depends on the SDK for real and the artifact
build inlines the SDK's published, self-contained bundle.

**Audit before stabilizing.**

1. **Resolved (Aug 2026, the narrow-grammar cutover): the protocol owns its
   own timeline vocabulary.** Bridges no longer construct `ThreadEvent`s —
   they emit the protocol's own `thread/delta` grammar and the runtime's
   assembler constructs every canonical event — so the `@bb/domain` event
   vocabulary (`ThreadEvent`, the item types, `threadScope`/`turnScope` and
   the scope helpers) left the surface with the kit's assembly machinery
   (turn-state registry, scoped-item-ids, accepted-user-messages, item
   constructors, unhandled-event builders). What still comes from
   `@bb/domain` is deliberate and consumed by bridges today: the
   command-plane and interaction surface the protocol's params are made of
   (`PromptInput`, `PendingInteraction*`, `DynamicTool`,
   `RuntimePermissionPolicy`, permission/reasoning/service-tier values,
   rate-limit state, workflow snapshots) plus the enum/status types the
   delta shapes reference (`ThreadEventItemStatus`, `ThreadEventTurnStatus`,
   `ThreadEventPlanStep`, `ThreadEventTokenUsageBreakdown`,
   `ThreadEventContextWindowUsage`, `ThreadEventUserContent`). Those are
   shared server/app/runtime contracts, so the facade re-export (bundle
   inlining, `@bb/domain` staying private) is the permanent answer for
   them.
2. **Surface size.** 184 names after the cutover (was ~190, then ~216 with
   the delta grammar added, then the assembly surface deleted: the
   turn-state/scoped-id/accepted-message/constructor helpers, the orphaned
   `buildEditDiff`/`withParentToolCallId`, and the unconsumed domain
   re-exports came off). Single-consumer
   repatriation done (Aug 2026): `extractEnvOverrides` and
   `getMessageContentTypes` moved into the claude-code plugin,
   `normalizePendingInteractionRequestedPermissionProfile` (whole
   `pending-interaction-normalization` module plus test) into the codex
   plugin, and the `cloneReasoningEfforts` helper out of `@bb/domain` into
   claude-code's model catalog. The other named candidates turned out not to
   be movable: they are `@bb/domain`/protocol definitions with core consumers
   — the `acp*Cli`/`acpNativeReasoning` schemas are parsed by the ACP launch
   spec and config, and the workflow snapshot types are rendered by the app.
   The `claudeTaskTool*` schemas lost their last core consumer when the
   claude-code plugin took over its task vocabulary, and the
   `hostDaemonAcpLaunchSpec*` pair stopped being a wire shape at protocol
   155; both stay on the facade only as scheduled removals (above). The
   surface is still large; any further shrink is a per-name product
   decision, not a mechanical move.
   A follow-up de-overfitting pass (Aug 2026) then unwound the kit's
   over-general helpers: `buildToolUseItem`'s parser-callback router became
   per-provider switches over plain constructors (`buildFileChangeItem`,
   `buildGenericToolCallItem`); the generic session registry was split into
   `createPendingToolCallTracker` plus consumer-owned session maps;
   claude-code stopped borrowing codex's `shell_environment_policy` namespace
   (`buildShellEnvironmentPolicyConfig` now lives in provider-codex,
   `diffCumulativeText` in pi); the zero-consumer native tool-call decoder,
   the `finishOpenProviderTurn` wrapper, and the per-consumer flags
   (`completeWebItems`, `preserveUndefinedToolCallFields`) came off the
   surface; and the shared accepted-user-message drain folded into the
   turn-state registry core.
3. **Resolved (stabilization S2): the ACP launch spec is the ACP package's
   own.** `acpLaunchSpecSchema` moved out of `@bb/host-daemon-contract` into
   `@bb/provider-bridge-acp` and left this root entry; provider-scoped static
   options are opaque to bb, and the shape is owned by the bridge that parses
   it and the plugin that stores it.
4. **`experimental_apiVersion` 1.** The bootstrap accepts version 1 only and
   refuses anything else by name. Decide the deprecation window for a version
   bump (a plugin's artifact and the daemon update independently) before the
   first third-party bridge ships.

## `@get-bb/plugin-sdk/provider-bridge/testing` (the provider-bridge testing kit)

**Kept experimental (2026-08-22).** items 3 and 6 below change the public shape (a pluggable replay child, pinning a grammar version in the exports).

**What it does.** The published kit a bridge author proves a bridge with
before shipping it, with no private `@bb/*` package in reach: the
conformance kit (`experimental_runBridgeConformance`,
`experimental_formatConformanceReport`) that drives a bridge through the
canonical protocol scenarios — the transport hands it raw wire messages
(`send` + `takeMessages`), the run names the bridge's `providerId`, and the
kit assembles every `thread/delta` batch itself, reverse-maps the turn ids
it names to the bridge, and releases the session it opened at the end; the
real delta assembler (`experimental_createDeltaAssembler`,
`ASSEMBLER_GRAMMAR_VERSIONS`) — the exact code the daemon runs, so a test
sees the canonical `ThreadEvent`s the runtime would build from the bridge's
`thread/delta` stream; the delta→event collector that feeds captured
notifications through it (`experimental_createBridgeDeltaEventCollector`,
`experimental_assembleCapturedThreadEvents`); the in-process JSON-RPC harness
(`experimental_captureBridgeJsonRpcOutput` with its `takeMessages` drain,
`experimental_createBridgeJsonRpcTestHarness`); the calibration
normalizer (`experimental_normalizeCalibrationEvents`,
`experimental_describeCalibrationEvents`); and the recorded-replay harness —
the regression oracle the first-party bridges use, keyed by the caller's
provider id and bridge module rather than a list of bb's providers:
`experimental_resolveProviderBridgeLaunch` (the bridge process as the
runtime spawns it, through the bootstrap the kit ships beside its bundle),
`experimental_replayRecording` (the recorded runtime lane in, the recorded
provider lanes played by the kit's replay child, the bridge's output
assembled), `experimental_assembleRecordedEvents`,
`experimental_compareParity`, `experimental_checkRecordedCellReplay` (the
recorded-cell conformance verdicts), `experimental_rerecordCurrentBridgeLane`
(the bridge's current output written beside a recording that is never
rewritten), and the recording readers (`experimental_readBridgeRecording`,
`experimental_listRecordedCells`, `experimental_withCurrentBridgeLane`).
Framework-agnostic (the stdout capture patches `process.stdout.write`
itself; nothing imports a test runner). Curated by hand, named exports only.
The echo example and every first-party bridge suite import only this entry
and `@get-bb/plugin-sdk/provider-bridge` — the "zero first-party privilege"
proof for the testing surface. In-repo the kit is `@bb/provider-bridge-
protocol`'s `assembler`, `conformance`, and `testing` subpaths.

**Audit before stabilizing.**

1. **Calibration normalizer scope.** `experimental_normalizeCalibrationEvents`
   interns the id fields the first-party goldens needed
   (`turnId`, `itemId`, `id`, `parentToolCallId`) and drops
   `providerCheckpointId`. Confirm the defaults against a third-party
   bridge's goldens before fixing them.
2. **Surface size.** 25 value exports plus 57 types (the eight no consumer
   used — the conformance client and opens-before-delta check, the cumulative
   text differ, the parity value/event/row normalizers, the cell replayer and
   the bootstrap path resolver — came off in the stabilization audit; the
   three of those that 0.4.15 had published are named in the "Removed
   outright" bullet of the compatibility windows above, the other five never
   shipped. The assembled-event lane the transport once fed went when the
   kit took over the assembly: `experimental_toConformanceMessages` throws
   naming its replacement for one release (compatibility windows above) and
   `CONFORMANCE_ASSEMBLED_EVENT_METHOD` is a scheduled removal).
   The JSON-RPC harness duplicates a little of the bridge kit's envelope
   parsing; fold or keep deliberately.
3. **Replay profile shape.** `ReplayProviderProfile` is the three seams the
   first-party bridges needed (`env`, `rewriteRuntimeLine`, `prepareState`)
   and `ReplayDialect` is the three protocols the replay child speaks
   (`json-rpc`, `claude-cli`, `pi-rpc`). A third-party bridge whose CLI
   speaks none of them cannot replay its provider lanes. Decide whether the
   dialect set grows, or whether the child becomes pluggable, before the
   profile is a promise.
4. **Two shipped programs.** The kit's bundle spawns `provider-bridge-worker-entry.mjs`
   and `replay-provider-child.mjs` from beside itself (`import.meta.url`),
   so the published package carries both under `dist/`. Confirm the bundled
   bootstrap tracks the daemon's (`apps/host-daemon/scripts/bundle-manifest.mjs`
   builds the same entry) — a drift would make a replay differ from
   production in argv or framing.
5. **Workspace-path restoration.** `experimental_replayRecording` rewrites
   this replay's temp workspace back to the recorded `cwd` in every line the
   bridge emits, so a bridge that derives paths from `cwd` compares with the
   recording. It is a textual substitution of a unique temp path; confirm
   no bridge emits that path in a form the substitution misses (URL-encoded,
   JSON-escaped backslashes on Windows).
6. **The canonical event vocabulary by name.** The kit exports `ThreadEvent`,
   `ThreadEventItem`, `ThreadEventItemPresentation` (+ its label, icon and
   tint parts) and the named item kinds (`ThreadEventDelegationItem`,
   `ThreadEventExtensionItem`, `ThreadEventFileReadItem`,
   `ThreadEventSearchItem`, `ThreadEventPlanStepsItem`,
   `ThreadEventWebSearchItem`, `ThreadEventWebFetchItem`,
   `ThreadEventBackgroundTaskItem`) as types, re-exported from `@bb/domain`
   and inlined into the bundled declarations. Before this a plugin test named
   the event type as `ReturnType<BridgeDeltaEventCollector["assembleMessage"]>[number]`.
   They are types only: a bridge never constructs an event (the assembler
   does), so no `experimental_` value ships with them. Audit: the persisted
   vocabulary now has a second public home beside `ProviderInfo` on the root
   entry; a breaking change to an item shape is a breaking change to the kit.
   Decide whether the kit should pin a grammar version in its exports (the
   assembler already names `ASSEMBLER_GRAMMAR_VERSIONS`) before stabilizing.

## `experimental_scanPublicSdkOnly` (`@get-bb/plugin-sdk/testing`)

**What it does.** Scans a plugin package for imports outside the public SDK:
walks every `.ts`/`.tsx`/`.js` file below the package root (skipping
`node_modules` and `dist`), and returns the files it read, each import
specifier that is a private `@bb/*` package or falls outside the allowlist —
`@get-bb/plugin-sdk` and its published subpaths, `zod`, `node:` built-ins,
relative paths that stay inside the package root, plus the public packages
the plugin names in `allow`; test files may add the published testing
subpaths and `vitest` — a relative path that resolves outside the package
root (`outside-package`, unless an `allow` pattern names it), an `import()`
or `require()` whose argument is not a string literal (`dynamic-specifier`),
and the `@bb/*` names in the package.json dependency blocks. It returns data
and imports no test runner; the suite asserts on it. The echo-provider
example and the first-party ACP plugin run it over themselves: inside bb's
monorepo a `@bb/*` import still typechecks and runs, and a relative path can
climb into a private package's source, which is exactly why it needs a test.

**Audit before stabilizing.**

1. **The allowlist is bb's.** The default admits every published SDK subpath
   and `vitest`; a plugin on another runner or another schema library must
   name it in `allow`. Decide whether the defaults should read the plugin's
   own package.json dependencies instead of a fixed list.
2. **Regex import extraction.** Specifiers are found by a regular expression
   over the source (`from "…"`, `import("…")`, `require("…")`), not a
   parser; an `import()`/`require()` whose argument is not a string literal
   is reported as `dynamic-specifier` rather than read, a string literal
   split across lines is missed, and a string that merely looks like an
   import (in a comment, say) is reported. Decide whether a parser is owed
   before the scan is a promise.

## `app.experimental_useProviders` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** the hook returns `ProviderInfo`, which carries the unresolved `icon` / `logoUrl` pair and `maintenance` (the pre-stabilization booleans an earlier draft served beside it were withdrawn before release; see "Removed outright" above); stabilizing the hook freezes that shape.

**What it does.** The provider directory for plugin frontends: `{ status,
providers }` where `providers` is the host's own `ProviderInfo[]` roster in
picker order (the same query the composer's provider tabs read, shared cache,
realtime invalidation). Pairs with the backend `bb.sdk.providers.list()`. It
exists so that a plugin showing a thread's provider (tasks, automations,
provider-retry) stops vendoring provider names, icons, and copy.

**Audit before stabilizing.**

1. **Routing.** The hook reads the primary-host roster (no `environmentId` /
   `hostId` argument), so installed-only providers of another machine are not
   listed. Decide whether plugins need host-scoped listing before freezing the
   signature.
2. **Icons.** Every provider bb ships now declares an SVG asset, served as
   `logoUrl` and drawn by the host as a `currentColor` mask (core vendors no
   brand marks), and a provider that declared a named glyph (`icon: "Zap"`)
   arrives as `icon: { glyph }` beside `logoUrl` (at most one of the two is
   set). Decide whether `icon` and `logoUrl` fold into one
   `{ glyph } | { url }` field — the presentation's `{ glyph }` form, where a
   glyph is a host name or `"<pluginId>/<name>"`, is the declaration-side
   precedent — when `ProviderInfo` stabilizes, and whether the mask rendering
   (monochrome by construction) is the contract or a full-color logo path is
   owed.

## `app.experimental_useCodeTheme` (`@get-bb/plugin-sdk/app`)

**What it does.** Returns `{ mode, name, theme }`: the app's active light/dark
mode, the registered name of the code theme bb renders that mode with, and the
resolved VS Code theme document behind it (`type`, `fg`, `bg`, `colors`,
`tokenColors`) — the same document bb's own highlighter paints from. It exists
for plugins that render code with an engine of their own (the Monaco file
editor is the first): without it, an embedded editor can only follow
light/dark and strands its syntax colors on a palette bb is not using.
`theme` is null only before the first resolve, and holds the previous document
while a palette switch resolves, so a consumer never paints an unthemed frame.

**Audit before stabilizing.**

1. **Shape of the document.** `PluginCodeThemeData` mirrors Shiki's
   `ThemeRegistrationResolved` minus the fields bb does not promise
   (`semanticTokenColors`, `include`, `displayName`). Decide whether freezing a
   Shiki-shaped payload is right, or whether the contract should be bb's own
   normalized token model — a Shiki major that changes `settings` normalization
   changes what plugins receive.
2. **Both modes at once.** The hook serves only the active mode. An editor that
   wants to prebuild its light and dark themes has to toggle to see the other.
   Decide whether the state should carry the pair.
3. **Where the resolve happens.** Resolution runs in the app window through a
   dynamic `@pierre/diffs` import and caches per theme name for the window's
   lifetime; a custom palette edited on disk keeps its old document until
   reload, because the versioned wire name only changes when the server
   re-resolves. Confirm that matches what the built-in surfaces do.
4. **Consumer count.** One consumer today. Confirm a second engine (CodeMirror,
   xterm) needs the same payload before the prefix drops.

## `app.slots.experimental_providerIcon` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers — every provider bb ships declares an SVG asset and `ProviderInfo.icon.glyph` / `logoUrl` cover both declared forms without a frontend bundle; the open questions are id squatting and whether the slot should exist at all (deleting it is the owner's call).

**What it does.** Lets a plugin frontend supply the React component bb draws
as one agent provider's icon: `{ providerId, icon }`, where `icon` receives
only the host's `className` (sizing; the declared `strings.iconTint` colours
it). The component wins over the provider's served `logoUrl`, which the host
otherwise draws as a `currentColor` mask. Registrations are replaced
wholesale with the rest of the plugin's slot set, so disable/uninstall/failed
reload falls back to `logoUrl`, then the declared glyph, then the generic
glyph. No provider bb ships uses it: each declares an SVG asset and the mask
rendering keeps it theme-aware with no frontend bundle (an icon-only bundle
cost four JS+CSS fetches and four icon remounts at every boot).

**Audit before stabilizing.**

1. **Id squatting and scoping.** `providerId` names a provider in a shared
   namespace, not a per-plugin slot id, and nothing checks that the plugin
   registering it also declared that provider. Today the host keeps the first
   claim by sorted plugin id and warns. Before stabilizing, decide whether the
   host should reject an icon for a provider the plugin does not own (the
   frontend does not currently know the registry's provider→plugin mapping),
   and whether the picker should surface a rejected claim to the user.
2. **Bundle size and boot ordering.** An icon now costs a frontend bundle: a
   provider plugin that previously shipped only a server entry pays esbuild +
   Tailwind on install and an extra module fetch, and the served logo covers
   the window before the bundle loads. That window is the whole session until
   a thread of the plugin's provider is opened, one of its forms is requested,
   or its panel route is visited: a provider plugin's bundle is deferred as a
   whole, so the icon (like every other slot the bundle registers) is absent
   from the picker and the sidebar at boot. The first-party provider plugins
   dropped their icon-only bundles for exactly this reason. Confirm the cost
   is acceptable for third-party icon-only plugins, or add a lighter delivery
   path (e.g. a declared inline SVG string sanitized by the host) before
   freezing the shape.
3. **Disposal and identity.** The icon component is resolved through a cached
   host wrapper keyed by provider id and `logoUrl`; the wrapper subscribes to
   the slot store so a disposed registration falls back mid-render. Audit that
   a crashing plugin icon is contained the way other slot components are (it
   renders inside host chrome, sometimes outside a slot error boundary), and
   that no host surface caches the resolved component across a reload.
4. **Rendering contract.** The host promises only `className` and expects
   inline markup. Decide whether to enforce that (no fetches, no portals, no
   interactive content) before plugins rely on richer components, and confirm
   the accessible label story: the host derives `ariaLabel` from its own
   provider data, falling back to the provider id, and the slot supplies none.

## `experimental_ProviderModelPicker` (`@get-bb/plugin-sdk/app`)

**What it does.** Exposes bb's execution picker as a controlled
`{ providerId, model, reasoningLevel, serviceTier? }` component for plugin
frontends. The host adapter reuses `useThreadCreationOptions` for catalog,
fallback, reasoning reconciliation, service-tier capability, retired-model,
branding, and model-projection policy, and renders the same
`ModelReasoningPicker` used by first-party composers. A provider tab is a
preview until its authoritative catalog resolves; the component then emits the
provider, default model, reconciled reasoning, and supported service tier as
one value without closing the picker, matching the composer. `routing` can
target one enrolled host or an existing environment;
omitting it uses primary-machine routing. `disabled` renders the same summary
without opening the picker. Verified catalogs also normalize an empty or stale
controlled selection; placeholder, failed, and empty catalogs do not.
`allowProviderChange={false}` hides provider tabs while retaining model,
reasoning, and service-tier selection for the controlled provider. Routing
never implies provider locking: an environment supplies host/workspace context
and can run more than one provider. `align` optionally places the popover at
the trigger's `"start"`, `"center"`, or `"end"` edge and defaults to
`"start"`.

Tasks delegation presets and Automations agent execution both use this
component end to end. They persist the same tuple and pass it to
`bb.sdk.threads.spawn`; neither plugin exposes a parallel catalog RPC.

Implementation: `apps/app/src/components/plugin/PluginProviderModelPicker.tsx`,
bound in `apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **Atomic controlled contract.** Confirm the four execution fields should
   remain one value and that selecting a provider should immediately choose its
   verified default rather than wait for an explicit model click.
2. **Routing.** Omitted `routing` follows the server's primary-machine routing;
   `{ kind: "host", hostId }` and `{ kind: "environment", environmentId }`
   cover machine- and workspace-dependent catalogs. Confirm those two routes
   are sufficient before stabilizing the discriminated union.
3. **Capability policy.** Confirm an unsupported provider should omit
   `serviceTier` while supported providers retain the controlled tier, and that
   reasoning should continue using the composer's closest-supported policy.
4. **Catalog failure and normalization policy.** Placeholder, failed, and empty
   catalogs never change the controlled value. A verified catalog normalizes
   stale values while selected-only retired models survive. Confirm silent
   retention on failure and automatic correction on success are preferable to
   explicit callbacks.
5. **Scope.** Validate settings and compact-form usage in external plugins,
   especially whether they need an explicit loading/error callback. Tasks and
   Automations currently rely on the picker-owned loading/error UI. Environment,
   permission, and prompt submission stay separate controls.

## `experimental_PermissionModePicker` (`@get-bb/plugin-sdk/app`)

**What it does.** Exposes BB's permission picker as a controlled
`{ providerId, value, onChange, routing?, align?, disabled?, className? }`
component. `align` accepts `"start"`, `"center"`, or `"end"` and defaults to
`"end"` for compatibility with the prompt-row placement.
The host adapter reuses `useThreadCreationOptions` and `PermissionModePicker`,
so supported modes, fallback order, compact labels, and the routed machine's
permission ceiling are identical to the composer. It displays modes above the
ceiling as disabled with the host explanation, renders a locked summary for a
provider with one mode, and emits a corrected mode when an authoritative
provider/routing change invalidates `value`. Placeholder, loading, and failed
lookups never mutate the controlled value.

Tasks delegation presets and Automations use this component beside
`experimental_ProviderModelPicker`; their frontend bundles no longer read the
provider directory or implement permission reconciliation. Server-side spawn
and update validation remains authoritative.

Implementation: `apps/app/src/components/plugin/PluginPermissionModePicker.tsx`,
bound in `apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **Controlled reconciliation.** Confirm automatic `onChange` after an
   authoritative capability/ceiling change is preferable to a separate
   invalid-state callback, and that provisional failures should remain
   read-only without changing the caller's value.
2. **Routing and provider coupling.** Confirm requiring both `providerId` and
   the shared host/environment routing is the right composable boundary. A
   provider switch across two sibling controls settles in two controlled
   updates rather than one combined execution tuple.
3. **Single-mode presentation.** Confirm compact/settings consumers should
   see a locked summary when only one mode is supported, while first-party
   composer call sites may continue hiding a non-choice.
4. **Permission ceiling behavior.** Audit hosts whose ceiling is below every
   mode a provider supports and decide whether the picker should render an
   explicit unavailable state instead of the controller's existing fallback.

## `app.slots.experimental_timelineRenderer` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; every audit item is about the prop shape and none has a consumer to answer it — the first real renderer (a Codex extension-kind body, or the echo example) precedes stabilization.

**What it does.** Lets a provider plugin's frontend render the expanded body
of the timeline rows it owns: `{ kind, component }`, where `kind` is one of
the plugin's own extension item kinds (`"<pluginId>/<name>"`, as declared in
`bb.providers.register({ extensionKinds })`) or `"tool"` for the
generic tool items of the providers the plugin registered. Core kinds
(messages, commands, file changes, reads, searches, delegations, plan steps)
always use bb's renderers and are customized through the bridge's persisted
`presentation` alone (docs/provider-plugin-api.md §5, Q17). The component
receives `{ row, payload, presentation, thread, Original }`; `Original` is
the host's declarative base for the body. The row header (the presentation's
label, glyph, tint and headline) stays host-rendered. The host drops a kind
outside the plugin's namespace with a warning, scopes `"tool"` to the plugin
that owns the thread's provider (`ProviderInfo.pluginId`), contains a crash
to the row (the declarative base renders instead). A provider plugin's
bundle loads in the same deferred boot pass as every other plugin's.

**Audit before stabilizing.**

1. **Body versus whole row.** The slot owns the expanded body under a
   host-rendered header. Decide whether a plugin may also replace the header
   (an inline widget with no disclosure, e.g. a goal card) before freezing
   the prop shape, and whether `suppress` should stay a bridge-only decision
   or the renderer may opt a row back in.
2. **Tool-row payload.** A `"tool"` row hands the renderer
   `{ arguments, output }` where `output` is the server's inline preview
   (head+tail) for long outputs. Decide whether the renderer gets the full
   output on demand (the core body fetches it through
   `timelineTurnSummaryDetails`) or only the preview.
3. **Provider ownership source.** `"tool"` scoping reads the thread's
   `ProviderInfo.pluginId` from the nearest thread provider context: the
   route's detail view provides its thread's, and the SDK `ThreadChat`
   provides the embedded thread's own (so a panel showing thread B under
   thread A's page resolves B's provider plugin and hands the renderer B's
   `providerId`). A host surface that renders rows with no such context, and
   a provider whose plugin was uninstalled, both resolve to "unknown owner",
   so no renderer applies; confirm that is the right failure mode for both.
4. **Legacy rows.** `presentation` is null on a tool row persisted before
   bridges attached one. Decide whether the renderer should see such rows at
   all, or only rows with a presentation.
5. **Mobile parity.** Mobile renders the declarative base and loads no plugin
   JS (by design). Confirm the base (label, glyph, tint, title, detail) is
   sufficient for the first-party extension kinds before a third party
   relies on a web-only upgrade.

## `experimental_NewThreadComposer` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; items 1 (a newly required create-thread field going missing silently) and 6 (projectless switching) need a consumer to validate.

**What it does.** The host-owned new-thread compose surface, the create-side
counterpart to `ThreadChat`. It renders bb's full control set — prompt editor
with @-mentions and expand, `+` attachments, provider/model/reasoning picker,
voice, submit, and the row beneath with project, environment, "Branch from:",
and permission mode — and calls `onSubmit` with a `NewThreadRequest`
carrying every resolved selection.

The composer deliberately does **not** create the thread. The plugin does,
through `bb.sdk.threads.spawn`, which auto-fills `origin: "plugin"` and
`originPluginId`. If the component created the thread it would go through the
host's `useCreateThread` and the thread would look host-originated. So the
rule is: the composer owns user selections; the plugin owns filing
(`sectionId`, `parentThreadId`, `title`, `visibility`) and attribution.

Implementation: the shared workflow is
`apps/app/src/components/promptbox/NewThreadComposer.tsx`; the SDK adapter is
`apps/app/src/components/plugin/PluginNewThreadComposer.tsx`, bound in
`apps/app/src/lib/plugin-sdk-app-impl.tsx`.

**Audit before stabilizing.**

1. **`NewThreadRequest` vs. what `threads.spawn` accepts.** The type mirrors
   the subset of `CreateThreadRequest` a composer can resolve. Confirm every
   field still round-trips through `bb.sdk.threads.spawn` unchanged, that
   `executionInputSources` still means the same thing to the server, and that
   no newly required create-thread field is silently missing. Note the
   composer runs `useThreadCreationOptions` with `scope: "component-local"`,
   which never reports a `providerId` provenance source even though the
   composer always sends an explicit `providerId`; decide whether that is
   correct before freezing the shape.

2. **Page-level behavior the adapter skips.** Fork seeds,
   quick-create-project, the guided machine-setup dialog, welcome/empty
   states, and codex-version submit blocking are all deliberately absent.
   Confirm none of them has become load-bearing for correctness (rather than
   convenience) on a plugin surface — codex-version blocking in particular
   means a plugin can submit to a machine whose CLI the primary surface would
   have refused.

3. **Draft and selection scoping.** Drafts persist under a
   `plugin-new-thread` scope keyed by `draftKey ?? pluginId`, and execution
   selections are component-local so a plugin panel never rewrites the user's
   persisted root-composer defaults. Confirm that is still the behavior
   plugin authors expect, and that `draftKey` is the right knob (versus, say,
   a per-instance ephemeral draft).

4. **No plugin composer host binding.** The instance passes no
   `pluginComposerHost`, so plugin composer customizations, banners, and
   `useComposer()` writes do not reach it. Decide whether composers rendered
   by a plugin should participate in that surface before stabilizing.

5. **Seeding props and the round-trip guarantee.** The `default*` props
   (`defaultProviderId`, `defaultModel`, `defaultReasoningLevel`,
   `defaultServiceTier`, `defaultPermissionMode`, `defaultEnvironment`) seed
   the composer from a stored `NewThreadRequest` so a plugin can re-open a
   saved configuration without silently resetting it to project defaults.
   They are seeds (uncontrolled), take precedence over project defaults, and
   re-seed on any value change — including user-touched selections — via the
   creation-options resetKey. `defaultEnvironment` maps args back to picker
   selections in
   `apps/app/src/components/plugin/new-thread-environment-seed.ts`; its
   unrepresentable variants (`project-default`, `personal` without a
   `hostId`, an `unmanaged` `path`) are documented on the prop. Before
   stabilizing, confirm the mapping still inverts
   `resolveRootComposeThreadEnvironment` (the round-trip tests in
   `new-thread-environment-seed.test.ts` and
   `PluginNewThreadComposer.test.tsx` guard this) and re-decide whether the
   re-seed-on-change rule should instead be an explicit reset nonce.

6. **Projectless contract.** The picker always offers "Don't work in a
   project", including when a plugin seeds a specific project. That choice
   submits the personal-project id (not `null`) with a `personal` workspace;
   plugin authors forward both fields unchanged and must opt into personal
   project metadata with `projects.list({ includePersonal: true })`. Before
   stabilizing, confirm unconditional project switching is right for embedded
   plugin workflows, rather than adding an explicit project-locking policy.

## `app.slots.experimental_appOverlay` (`@get-bb/plugin-sdk/app`)

**What it does.** Mounts an additive plugin React component once per BB app
window, outside route-owned layout regions and inside `PluginSlotMount`. The
component receives no props and owns its chrome, positioning, visibility,
focus, and responsive behavior. It can call app-level SDK hooks and either
render fixed UI directly or create a React portal without losing plugin,
router, query, realtime, or sidebar thread/action context. Hooks whose contract
requires a particular surface, including `useComposer` and `useComposerView`,
remain limited to that surface. One overlay crash hides only that registration;
sibling overlays remain mounted.

**Audit before stabilizing.**

1. **Name and boundary.** Confirm "app overlay" is broad enough for floating
   widgets, launchers, and transient app-wide UI without inviting plugins to
   replace host-owned navigation or layout.
2. **App-level versus pane-level context.** Define the selected route in split
   layouts and document which pane-local capabilities remain unavailable to a
   once-per-window owner, including composer and side-panel hosts.
3. **Host-owned layer.** Decide whether arbitrary fixed/portalled content is
   sufficient or BB should provide a named overlay root, z-index band,
   collision area, docking, or drag persistence.
4. **Responsive and accessibility policy.** Audit keyboard access, focus
   restoration, escape behavior, compact drawers, reduced motion, and whether
   any of those must become host-owned rather than plugin-owned.
5. **Multiplicity and budgets.** Registrations are additive with no cap.
   Measure startup, query fan-out, visual collisions, and several plugins
   mounting persistent widgets in one window.
6. **Lifecycle.** Verify exact once-per-window mounting across route changes,
   split changes, frontend reload, disable, uninstall, app teardown, and
   multiple desktop windows or browser tabs.
7. **Crash and stylesheet lifetime.** Confirm a hidden crash fallback and the
   standard slot-owned CSS retention are the right failure semantics for UI
   that may have no in-layout representation.

## `app.slots.experimental_newThreadPanelAction` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; item 5 (merging with `threadPanelAction`) is explicitly deferred until an external plugin adopts it.

**What it does.** Adds a plugin row to the root New thread screen's
right-panel Actions list. Activating it can open a closable panel tab whose
component receives `{ projectId: string | null, params: JsonValue | null }`.
It deliberately does not reuse `threadPanelAction`: that existing contract
requires `threadId: string`, and the in-repo and external consumers built
against it may assume a thread exists. The two slots are surface-specific and
never cross-render.

Before stabilization, audit:

1. **Surface naming.** Confirm "New thread" remains the product name and the
   slot should stay panel-specific rather than becoming a broader root-compose
   action surface.
2. **Context breadth.** Confirm the selected `projectId` is sufficient. A
   plugin can use the composer hooks for the live draft, but the slot does not
   expose the root composer's selected host, environment, provider, or model.
3. **Project changes.** An open tab receives the current project on every
   render, while `run` receives the project selected when the row was
   activated. Confirm that distinction is intuitive and whether changing
   projects should close or re-key open tabs.
4. **Persistence.** Tabs and JSON params persist in the root panel's fixed
   state. Confirm restoring a plugin tab before registrations load, after a
   plugin is removed, and in projectless compose has the right fallback.
5. **Relationship to `threadPanelAction`.** Confirm separate opt-in remains
   preferable to a unified discriminated context after external plugins have
   had time to adopt the root surface deliberately. The two contexts' `openPanel`
   signatures were already unified: both take `PluginPanelActionOpenOptions` and
   return `boolean` (true = accepted, false = declined), matching
   `messageAction`'s `openPanel` and `useBbNavigate().openThreadPanel`. Do not
   re-litigate that in the stabilization audit; audit only whether the two
   _contexts_ should merge.

## `app.experimental_sidebarFooter` (`@get-bb/plugin-sdk/app`)

**What it does.** Registers host-rendered icon items in the app sidebar footer.
An item is either an `action`, whose `onActivate` callback runs when selected,
or a `disclosure`, whose React component is revealed above the footer row. The
host owns button chrome, accessibility, responsive containment, and a
single active disclosure across all plugins. A disclosure component owns
everything inside its boundary and receives only `dismiss()`.

Registering an action returns nothing. Registering a disclosure returns a
controller that can request `open`, `close`, or `toggle`. Those requests go
through the host's shared active-item coordinator, so opening one plugin's
disclosure replaces another and a stale scoped `close` cannot dismiss a sibling.
The existing `app.slots.sidebarFooterAction` remains a compatibility surface and
renders in the same footer row.

**Audit before stabilizing.**

1. **Naming and shape.** Confirm `sidebarFooter`, `action`, and `disclosure` are
   the durable concepts, and whether the managed namespace should keep one
   discriminated `register` method or split registrations by behavior.
2. **Imperative controller.** Validate real plugins can issue open requests
   without leaking subscriptions across frontend generations. Decide whether
   a declarative external-store contract would be safer.
3. **Programmatic opening.** Confirm `open()` should remain available. The
   intended policy is direct user-driven flows; background changes should not
   surprise-open sidebar content.
4. **Disclosure lifecycle.** Components currently mount only while open and
   remount after dismissal. Confirm plugins do not require retained hidden state,
   or add an explicit retention policy before stabilizing.
5. **Footer capacity.** Establish overflow behavior when several plugins
   register items, including compact viewports and icon-collapsed sidebars.
6. **Compatibility.** Migrate representative users of
   `sidebarFooterAction`, then decide whether stabilization replaces and
   deprecates that method or keeps action registration in both surfaces.
7. **Focus and dismissal.** Validate icon toggling, Escape, focus return,
   disclosure replacement, plugin reload, crash isolation, and removal while
   open across desktop and compact sidebar layouts.

## `app.slots.experimental_sidebarNavigation` (`@get-bb/plugin-sdk/app`)

**What it does.** Replaces the bounded sidebar navigation controls for New
thread, Search threads, Extensions, and plugin panel destinations. The plugin
receives semantic items, split-drag bindings, and one host activation callback.
BB retains the drawer, thread list, footer, resize handle, and hidden-body
shortcut policy.

Search activation opens the quick palette. The removed inline sidebar search
field, query state, combobox, and result list do not form part of this API.
`experimental_Original` bypasses replacement resolution. A crash restores only
the bounded controls and leaves the retained sidebar regions mounted.

**Audit before stabilizing.**

1. **Boundary.** Verify plugins can express useful navigation without control
   of the drawer, thread list, footer, resize handle, or shortcuts.
2. **Semantic items.** Confirm the action and icon variants cover current
   navigation without exposing routes or host React elements.
3. **Split contract.** Audit `experimental_splitProps` and
   `experimental_activate(..., { openInSplit })` for pointer, keyboard,
   modifier-click, pane-cap, and compact behavior.
4. **Search action.** Confirm a semantic quick-palette action remains useful
   without the former inline query and result UI.
5. **Crash and delegation.** Verify `experimental_Original` and crash fallback
   never recurse or remount the thread list and footer.
6. **Arbitration.** Confirm Automatic remains the correct default when several
   navigation replacements exist.
7. **Accessibility.** Validate labels, `aria-current`, shortcut metadata,
   disabled state, and focus order in third-party markup.

## `app.slots.experimental_threadList` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** examples only; no shipped consumer has tested the arbitration/fallback model or the accessibility contract.

**What it does.** Replaces the sidebar's scrolling thread list with a plugin
component. Unlike every other `app.slots.*` member this slot is **exclusive**:
one list at a time fills the scroll area. Automatic activation is the default.
If several are registered, the first in the slot snapshot wins (plugin ids are
sorted, then each plugin's registration order is preserved); removing the
automatic winner reveals the next. The user can override that behavior under
Settings → Appearance by pinning BB's list or a specific provider; the choice
is stored per client. A plugin-owned enable/disable setting can also live in
the component, which renders `Original` when disabled.

Fallbacks keep the sidebar usable: no automatic provider renders BB's list; an
unavailable pinned provider temporarily renders BB's list without erasing the
choice; and a crashing component renders BB's list (not the usual "plugin
crashed" chip, which in place of a whole sidebar would strand the user) plus
one toast.

**Audit before stabilizing.**

1. **Arbitration.** Confirm automatic/pinned/built-in is the right long-term
   selection model and alphabetical plugin-id order is an acceptable default
   tie-breaker when multiple replacements are enabled.
2. **Fallback discoverability.** Confirm one toast is the right signal when a
   crash silently swaps the user's sidebar back.
3. **Region boundary.** The plugin gets the scrolling list and nothing else:
   the New-thread button, search action, plugin nav rows, and footer stay
   host-rendered, because they are shared surfaces (other plugins live in two
   of them) and a replaced list must not remove them. Confirm no real sidebar
   needs to claim more, and that passing those regions down as props — letting
   a plugin place them, at the risk of dropping them — stays the wrong trade.
4. **Search compatibility.** Confirm released plugins no longer need the
   required deprecated `searchQuery` field before removing it in a deliberate
   breaking change. Until then, the host supplies `""`.
5. **Accessibility.** Confirm the host can still guarantee list semantics,
   focus order, and the mobile close behavior when a plugin owns the markup —
   `onNavigate` is currently the plugin's responsibility to call.

## AI services (`bb.experimental_aiServices.register`, `@get-bb/plugin-sdk/ai-services`)

**Kept experimental (2026-08-22).** one consumer (the codex plugin); the 5 MB plugin-served transcription cap (the old direct path allowed 25 MB) and the host-pull alternative are still open; the reserved-id model is now one static SDK list (`SERVER_DIRECT_AI_SERVICE_IDS`), pinned to pi-ai's provider registry by plugin-ai-services.test.ts.

**What it does.** Lets a plugin serve bb's own AI services — server-side
helper inference (thread titles, commit messages: prompt + JSON Schema in,
structured value out) and voice transcription — from its `bb.host` entry.
`bb.experimental_aiServices.register({ id, displayName, kinds })` stages the
service during the factory and lands it when the load commits; the host entry
implements `experimental_aiServicesHostContract` (`ai.inference.complete`,
`ai.voice.transcribe`), both carrying `serviceId`. Core routes the user's
`BB_INFERENCE` / `BB_TRANSCRIPTION` (`<serviceId>/<model>`) to the plugin
through the generic host RPC call on the primary host; failures ride the result
(`{ ok: false, code }`) so core's retry/fallback policy stays generic. Ids the
server serves itself (`openai` transcription, the builtin inference providers)
are reserved: they route server-direct before the registry is consulted and a
plugin cannot register them, so a plugin can never capture that traffic. A
cross-plugin id collision fails the later plugin's load at the `register`
call. The
codex plugin is the first registrant (its ChatGPT client moved out of the
daemon); `GET /system/config` and `bb settings ai-services` list the registered
options.

**Audit before stabilizing.**

1. **Chooser.** Confirm `BB_INFERENCE` / `BB_TRANSCRIPTION` strings stay the
   setting, or move to a structured core setting whose options are the
   registered services (a picker needs per-service model lists, which the
   contract does not carry yet).
2. **Payload cap.** A plugin-served transcription travels as base64 inside one
   host RPC call (8 MiB JSON cap → 5 MB audio), a regression from the 25 MB
   the server-direct path accepts for long recordings (owner decision: keep
   for now). The alternative is a host pull: the server stores the audio
   under a short-lived token and the call carries the token, so the host
   worker fetches the bytes over the internal route instead of receiving
   them inline; decide whether that or a streamed path replaces the cap.
3. **Failure vocabulary.** Confirm the six codes are enough for core's policy
   and whether a service should be able to declare per-call retry hints.
4. **Multiple services per plugin / per kind.** Confirm the `serviceId`-on-
   every-call shape and the first-registered-wins collision rule.
5. **Host choice.** Calls go to the primary host; decide whether a service may
   declare which host(s) can serve it.

## `PluginFileOpenerSource.experimental_hostId` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** persisted in opener-tab `paramsJson`; items 3–4 (every source kind vs project-only; omission semantics) decide whether the stable name is `hostId?` or a required field.

**What it does.** Identifies the explicit host selected for a project-backed
workspace file when a file opener cannot resolve that source through a thread
or environment. It is omitted for environment-backed workspace files, host
files, thread-storage files, and project files that use the primary host.

**Audit before stabilizing.**

1. Confirm an explicit host id is the minimum missing project-routing context,
   rather than exposing the whole project workspace routing union.
2. Verify project-compose file tabs retain the selected host across reloads,
   host changes, plugin fallback, and per-open viewer overrides.
3. Decide whether host identity should be present for every source kind or
   remain project-specific once more file opener plugins exercise the API.
4. Confirm omission should continue to mean primary-host resolution and that
   this remains compatible with persisted opener tabs created before the field
   existed.

## `experimental_SourceCode` / `experimental_Diff` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** one consumer (the github plugin's `Diff`); items 2–4 (multi-file input, language override, worker pool at the component) all change the prop surface.

**What it does.** Two host-owned renderers for supplied code content.
`experimental_SourceCode` takes source text plus a path and owns syntax
highlighting, gutters, wrapping, highlighted-line presentation, and the live BB
code theme. `experimental_Diff` takes a single-file patch plus a path and
optional `experimental_fullFileContents` for both text sides, and owns patch normalization
(a patch without a `diff --git` header is completed from `path`, which is what
makes GitHub's REST patches and bare `@@` hunks render), context enrichment,
syntax highlighting, unified/split presentation, gutters, and the same live
theme. Patch content that will not parse degrades to plain monospace text. The
caller still owns loading file contents; omission means a patch-only render
without context expansion.

These are the same components BB's own file preview, timeline file diffs, and
environment diff panel render through, so an active
`experimental_sourceCodeRenderer` / `experimental_diffRenderer` replacement
covers first-party surfaces and plugin surfaces at once. Fetching files or git
data, multi-file lists, tabs, card headers, git actions, and add-to-prompt
behavior deliberately stay with the caller.

**Audit before stabilizing.**

1. **Prop surface.** Confirm content + path + presentation plus optional full
   diff sides is the right minimal contract, and decide whether `className`
   belongs in it at all — a
   replacement never receives it today, so a `className` that only styles BB's
   renderer is a quiet inconsistency.
2. **Diff input shape.** Confirm single-file patch text is the right currency.
   Multi-file patches, `processFile`-style pre-parsed input, and per-hunk
   rendering are all things callers have wanted; none are expressible now.
3. **Language selection.** Highlighting is inferred from `path` only. Confirm
   an explicit language override is not needed before the names freeze, and
   that no implementation-library language union leaks in when it is added.
4. **Worker pool.** Highlighting needs BB's Pierre worker pool from React
   context. Thread panes and plugin nav panels provide one; homepage and
   settings sections do not, so a diff rendered there is unhighlighted rather
   than broken. Decide whether the host should provide the pool at the
   component instead of the surface.
5. **Selection to chat.** BB's own surfaces pass a selection-to-composer
   handler that the public component withholds. Confirm plugins should reach
   that through `useComposer()` rather than a renderer prop.
6. **Size and virtualization.** Neither component caps input size or
   virtualizes. Audit against a plugin that renders a very large file or patch.
7. **Resolved (Aug 2026): context expansion takes resolved semantic data, not
   a loader callback.** `experimental_fullFileContents` carries required `old` and `new`
   `{ path, content }` objects. This keeps lazy loading, retries, and viewport
   policy with the caller while letting BB's renderer and a replacement consume
   complete UTF-8 sides without exposing Pierre's `FileContents` type. A
   replacement always receives the caller-resolved field as an object or
   `null`, and owns patch-consistency validation if it uses those contents for
   expansion. BB's original validates only when its lazy renderer mounts.

## `app.slots.experimental_sourceCodeRenderer` / `app.slots.experimental_diffRenderer` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero registrations; "two slots or one" changes the registration shape.

**What it does.** Replaces BB's source or diff renderer everywhere it draws
supplied content — the native file preview, timeline file diffs, the
environment diff panel's file bodies, and every plugin calling the public
components. Like `experimental_threadList` these slots are **exclusive**: one
renderer each. Registering activates it while the plugin is enabled; if several
are registered the first in slot snapshot order wins (plugin ids sorted, then
each plugin's registration order). The user can override that under
Settings → Appearance ("Source code" and "Diffs") by pinning BB's renderer or
a specific provider; the choice is per client, and it is the same
automatic/built-in/named-provider model the sidebar thread list uses. There are
deliberately no scope, extension, or enabled-by-setting filters on the
registration — conditional behavior belongs in the component, which decides per
call from its semantic props and renders `Original` when it does
not want the render.

Fallbacks: no registration renders BB's renderer; a disabled or uninstalled
plugin reveals the next registration or BB's renderer; a component that throws
renders BB's renderer through the slot's crash fallback. A pinned provider that
is temporarily unavailable renders BB's renderer without erasing the pin.

**Audit before stabilizing.**

1. **Arbitration.** Confirm automatic/pinned/built-in is the right long-term
   selection model here as it is for the thread list. **Resolved (Aug 2026):
   the pin stays per client.** A device-local override matches the sidebar
   thread list, even though the key/value app settings added in #1875 would
   now make an account-level pin cheap to add. Still open: the two renderers
   pin independently; confirm users do not instead expect one "code rendering"
   choice.
2. **Resolved (Aug 2026): a crash swaps back to BB's renderer silently.**
   A diff card is not a whole sidebar — the reader still sees a correct diff,
   where a blank thread list strands them — so neither host passes `onCrash`.
   Authors are not left without a signal: `PluginSlotBoundary` still
   `console.warn`s the plugin id, slot key, and component stack. The hosts pass
   no `instanceId`, so the first crash disables the slot for the session rather
   than letting cards crash one at a time.
3. **Resolved (Aug 2026): the replacement is global, other plugins'
   surfaces included.** "Install this and every diff looks like X" is the
   point; covering BB's surfaces but not the GitHub plugin's would be a
   half-measure, and a plugin calling `experimental_Diff` would silently opt
   its users out. No first-party-only or own-surfaces-only scope. Audit this as
   precedent rather than as a fact about these two slots: no other slot lets a
   plugin reach into another plugin's rendered output.
4. **Capability parity. Resolved for context expansion (Aug 2026):** a
   replacement receives `experimental_fullFileContents` as an object or `null`,
   matching the public host component and first-party diff cards. These are
   caller-resolved contents; a replacement that implements expansion also owns
   consistency validation against `patch`. Selection-to-chat and the
   deleted-file gate remain host-only; confirm that remaining asymmetry is
   acceptable, or promote either capability before stabilization.
5. **Two slots or one.** Confirm source and diff should stay separately
   replaceable rather than one "code renderer" registration.

## `experimental_useSidebarThreads` / `experimental_useSidebarThreadActions` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; items 4 (a paged/windowed read at 10k threads) and 5 (the draft indicator gap) are unresolvable without one and both change the contract.

**What it does.** Gives a plugin component the sidebar's live thread view and
the actions that mutate it. The read hook wraps the host's own
`useSidebarNavigation` query — the same cache and realtime subscriptions the
built-in sidebar uses — so a plugin list costs no extra request and updates on
exactly the same events. The action hook routes to the host's own mutations, so
optimistic updates, toasts, and cache invalidation are identical.

`PluginSidebarThread` is a deliberate copy of the fields a sidebar needs, not a
re-export of the internal `ThreadListEntry`. `indicator` is
`resolveThreadListIndicator` already run by the host, so plugins inherit bb's
precedence (attention before work; plan and goal before the spinner) instead of
reimplementing it, and `indicatorLabel` carries the matching accessible string.

**Audit before stabilizing.**

1. **DTO scope.** Confirm every field earns its place and that the copy stays
   worth its maintenance over `ThreadListEntry`. `hasUnsubmittedDraft` is
   deliberately absent (client-local composer state); confirm plugins do not
   need it. `host` is resolved host-side to `{ id, name }` because a plugin
   cannot turn a host id into a machine name — confirm resolution belongs here
   rather than in a separate hosts hook, and that falling back to the id for an
   unknown host is the right failure.
2. **Indicator coupling.** `indicator` freezes bb's precedence into the
   contract. Confirm new kinds can ship without breaking plugins, and that the
   documented "treat unknown as none" rule is enough.
3. **Unread semantics.** `isUnread` is plain read state, so it is true for
   child threads and running threads that `isUnreadDoneThread` excludes by
   design. Confirm that is the more useful primitive for a replaced list.
4. **Scale.** Confirm one array of every thread is right at ten thousand
   threads, versus a paged or windowed read. Today the host memoizes each
   thread DTO per unchanged `ThreadListEntry` (React Query structurally shares
   the payload), so a refetch that changes one thread hands plugins the same
   objects for every other thread and a `memo`/compiler-memoized row bails
   out; the array itself is new whenever the payload changes. Plugin lists
   are still expected to window their rows (the built-in sidebar does): the
   host does not cap the array, and mounting one row per thread on a phone is
   the plugin's cost. Decide whether that expectation should be enforced by
   the contract (paged/windowed read) before stabilizing.
5. **Draft indicators.** `indicator` never reports "draft" or "working-draft",
   because an unsubmitted draft is per-composer client state the host reads per
   row. An idle unread thread holding a draft therefore reads as
   "unread-success" where the built-in row paints "draft". Decide whether to
   close that gap (a per-thread draft hook) or keep it documented.
6. **Action surface.** Destructive and dialog-bearing actions route through
   `useThreadActions()`, so `archive` closes panes and repairs the route, and
   `requestDelete` opens bb's confirmation rather than deleting silently.
   Confirm that split (silent `rename`, host-confirmed delete) is the right
   line, and decide whether bulk actions and undo belong here.
7. **Permission.** Decide whether `archive` and `requestDelete` need any plugin
   permission gate beyond installation trust.
8. **`experimental_useSidebarThreadPullRequest`.** Per-row and opt-in, because
   a PR lookup hits the git host and therefore cannot sit on the payload every
   sidebar loads. It reuses the host's environment-keyed query, so threads
   sharing a worktree share one lookup and the host keeps its own staleness and
   refetch rules. Before stabilizing, confirm: the narrowed DTO (number, title,
   url, state, attention) is enough without leaking checks/review/mergeability;
   a sidebar of many distinct worktrees does not stampede the git host; and
   returning `null` for "lookup failed" (rather than an error) is the right
   failure for a row that should simply show nothing.
9. **`experimental_useSidebarThreadSplit`.** Gives a custom row the built-in
   drag-to-split gesture: spread `splitProps` onto the row, gate any affordance
   on `isAvailable`, and read `layout` to paint where the thread already sits.
   The host owns every rule — the drag engages only after the pointer leaves the
   sidebar, an edge drop splits, a center drop replaces, an open thread focuses
   its pane, and the pane cap turns a split into a replace — so a plugin cannot
   reach a layout the built-in sidebar cannot. Before stabilizing, confirm: a
   list with its own pointer-drag (reorder, swipe) still composes with the
   host's engage threshold; `splitProps` staying an open object is the right
   forward-compatible shape, or it should narrow to a named handler; and
   exposing the full `panes` array does not leak more layout state than a row
   needs.

## `app.slots.experimental_threadHeaderAction` (`@get-bb/plugin-sdk/app`)

**Kept experimental (2026-08-22).** zero consumers; item 1 (merging behind one registration with `bb.ui.registerThreadAction`) is cheapest to decide before the first one.

**What it does.** Renders a plugin component in the thread header's action row.
The frontend sibling of the backend `bb.ui.registerThreadAction`, which renders
a host-owned button and runs server-side: use that one for "do a thing", and
this one when the control must draw live state (a count, a cluster, a status).

The host places it at the left end of the row, before the workspace button, git
actions, the panel toggle, maximize, and close — the same slot the backend
actions already use. It mounts once per pane, each with that pane's `threadId`.
A crash removes just that control and leaves the rest of the header working.

**Audit before stabilizing.**

1. **Two APIs, one region.** `bb.ui.registerThreadAction` and this slot now
   share a row. Confirm the ordering rule between them, and whether the two
   should merge behind one registration.
2. **Budget.** The row is short and already holds five host controls. Decide a
   cap, or an overflow behavior, before three plugins each add one.
3. **Compact viewport.** `isCompactViewport` asks every plugin to collapse
   itself. Confirm that beats a host-owned overflow menu.
4. **Per-pane mounting.** Confirm plugins handle mounting once per pane, and
   that a popover opened in one pane cannot leak into another.
5. **Height discipline.** The host clamps the control's layout box
   (`max-h-7 max-w-64`) so it cannot grow the chrome row, but deliberately does
   NOT clip overflow — clipping also hides a popover anchored to the control,
   which is the normal way to show anything taller. A plugin can therefore
   still paint outside the row. Decide whether that trade is right, or whether
   the host should require a portal.
6. **Other headers.** Decide whether the compose screen, plugin panels, and the
   workspace header need the same slot, or stay host-only.

### Note on `experimental_threadHeaderAction` crash isolation

`PluginSlotMount` takes an optional `instanceId` that participates in the
crashed-instance key, so one pane's crashed header control does not disable the
other pane's copy (or release its owned state). The thread-list slot omits it
deliberately: it mounts once, and a crash there should disable it everywhere.
Confirm that split before stabilizing, and decide whether other multi-mount
slots need the same treatment.

## `useComposer().experimental_submit` (`@get-bb/plugin-sdk/app`)

**What it does.** Runs the composer's own submit pipeline with the draft that
is on screen, queueing the result until `sendAt` instead of dispatching it.
In a thread composer that is a queued row waiting on the clock; in the
new-thread composer the thread is created `pending` and its first message is
the queued row, so nothing provisions until the row comes due. The point is
that everything the user selected travels with the
submission — attachments, @-mentions, and for a create the provider, model,
reasoning level, service tier, permission mode and environment — none of
which is reachable from a plugin backend, so a
plugin-issued `threads.send`/`threads.spawn` would silently schedule a
different message from the one being composed. Backed host-side by an optional
`submit` on the internal `PluginComposerHost`, supplied by the thread
composer (`ThreadDetailPromptArea`) and the new-thread composer
(`NewThreadComposer`) and omitted everywhere else. Rejects with a
user-presentable message when the composer refuses; request failures reject
too, after the host has restored the draft. Sole consumer:
`plugins/scheduled-send`.

**Audit before stabilizing.**

1. **Options is a one-field object with no "submit now" arm.** `sendAt` is
   required, so the method can only schedule. That is deliberate — an
   unconditional "send the user's draft" capability is a much larger surface
   than scheduling needs — but confirm the shape before a second option
   (`mode`, `senderThreadId`, a queue hint) has to be added, because adding one
   makes `sendAt` optional and re-opens the "submit now" question.
2. **Two of four scopes are unsupported.** A queued-message editor and a side
   chat have no `submit`, and the route-draft fallback (a plugin surface
   mounted outside any composer) has none either. All three reject with the
   same "cannot schedule a submission" message, so a plugin cannot tell
   "unsupported here" from "no composer mounted". Decide whether
   `ComposerView` should advertise submit capability so a `+` menu row can
   disable itself instead of failing on click.
3. **Double error reporting on the create path.** A failed scheduled _send_
   is reported only through the rejection (`useSendThreadMessage` sets
   `showErrorToast: false`). A failed scheduled _create_ is also toasted by
   the create mutation's default error handling, so the user sees the reason
   twice — once in the plugin's picker and once in a toast. Decide whether the
   host should suppress its toast for programmatic submissions.
4. **Freshness of `sendAt`.** The host rejects a non-future `sendAt` at
   call time and the server accepts any non-negative timestamp, dispatching a
   past one inline at once. The only guard against a time that goes stale
   between the plugin computing it and the request landing is that window
   being small. Decide whether the send/create routes should refuse a
   `sendAt` in the past outright.
5. **No submission identity is returned.** The method resolves with nothing, so
   a plugin cannot address the queued row it just created (to edit or delete
   it) without listing the thread's queue. Confirm whether the queued message
   id belongs in the result.
6. **`NewThreadRequest.sendAt`.** The same field is now visible to plugins
   hosting `experimental_NewThreadComposer`: a scheduled submission there
   reaches the plugin's `onSubmit` carrying `sendAt`, which the plugin must
   forward to `threads.spawn`. A plugin that reconstructs the spawn request
   field-by-field instead of forwarding it will drop the schedule silently.
   Confirm that forwarding expectation is documented well enough, or make the
   composer refuse to schedule when it is plugin-hosted.

## Desktop browser control

`bb.sdk.experimental_desktopBrowsers` and the exported `ExperimentalDesktopBrowsersArea`, `ExperimentalDesktopBrowserScope`, `ExperimentalDesktopBrowserLease`, `ExperimentalDesktopBrowserCreateInput`, and `ExperimentalDesktopBrowserAcquireInput` expose explicit host/window/thread discovery, isolated tab creation, expiring control leases, scoped CDP connections, capture, reveal, close, release, and disposable tab-state subscriptions. The matching core CLI is `bb browser`.

Before stabilization, audit personal-profile handoff policy, per-tab mutual exclusion and child-target scope, native popup handling, debugger detachment, daemon/desktop disconnect and reconnect generations, expiry and cancellation races, bounded screenshot bytes, and cross-platform desktop startup. Connection credentials must remain private to workers on the browser host. `subscribe` polls every two seconds with one outstanding request; it is state observation, not a lossless event log. Cloud browsers and external provider registration are outside this surface.
