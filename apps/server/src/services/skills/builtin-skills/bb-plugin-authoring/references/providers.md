# Agent provider API

### bb.providers.register — agent providers

A plugin can contribute a full agent provider: a picker entry whose threads
run on a **provider bridge** the plugin ships. The working reference is
`examples/plugins/echo-provider` — declaration, bridge, and conformance test
in one small package.

```ts
bb.providers.register({
  id: "echo-agent", // stable public id; thread rows persist it
  displayName: "Echo Agent", // 1-80 chars, shown in the picker
  icon: "./icons/echo.svg", // optional; the bb.branding.icon forms plus a declared icon
  family: "echo", // optional grouping key for related providers
  // Copy core surfaces render (usage banners, pickers, the guide).
  strings: {
    signInHint: "Run `echo-agent login` on the machine to sign in.",
    expiredHint:
      "Your Echo session expired. Run `echo-agent login`, then reload.",
    installUrl: "https://example.com/echo-agent",
    brandPrefix: "Echo ", // optional; stripped from model display names
    planModeCopy: "Echo will plan without executing.", // optional
    iconTint: { light: "#334155", dark: "#CBD5E1" }, // optional
  },
  // Optional immutable JSON forwarded opaquely to this plugin's bridge.
  experimental_bridgeOptions: { launch: { command: "echo-agent" } },
  // "installed" hides the row until provider/health finds the executable.
  experimental_visibility: "always", // default
  // Sessionless maintenance support (each defaults to false) so bb can skip
  // unsupported host probes and hide providers that never expose usage. A
  // shared bridge that declares usage may still return no windows or
  // supported: false for one id.
  maintenance: { health: false, usage: false, installation: false },
  capabilities: {
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    fork: "none", // "none" | "tip" | "checkpoint"
    supportsManualCompaction: false,
    supportsThreadArchive: false, // bb mirrors archive/unarchive onto it
    supportsThreadRename: false, // bb forwards renames to it
    permissionModes: ["full"], // non-empty, no duplicates
    reasoningLevels: ["medium"], // coarse fallback ladder
  },
  // Labelled picker options; the coarse ladder above is labelled for you
  // when these are omitted. `model/list` is precise per model at runtime.
  reasoningLevels: [{ id: "medium", label: "Medium" }],
  serviceTiers: undefined, // e.g. [{ id: "fast", label: "Fast" }]
  composerActions: [], // skills typeahead is implicit; ["plan"] opts into plan mode
  // Cold-cache fallback models: shown only until the first model/list probe
  // completes, or when a probe fails transiently. A non-empty list has
  // exactly one isDefault; an empty or omitted list is valid.
  // `scope` says how far one model/list answer travels: "host" when the
  // bridge answers from account or agent state and ignores the workspace
  // path (bb then probes once per machine), "workspace" (the default) when
  // project configuration can change the answer.
  models: { fallback: [], scope: "workspace" },
  // Daemon env vars the bridge may read. Provider processes are spawned with
  // inherited BB_* variables stripped; exactly these are forwarded.
  env: { passthrough: ["BB_ECHO_AGENT_EXECUTABLE"] },
  // Called by the server on EVERY session and turn command. The returned
  // JSON reaches the bridge as `options.providerOptions`; core never reads
  // it. This is where the provider's own knobs travel — read them from the
  // plugin's own `bb.settings.define` values in `ctx.settings` (secrets are
  // omitted). `ctx.promptMode` is "plan" when the prompt entered plan mode.
  deriveProviderOptions(ctx) {
    return {
      verbose: ctx.settings.verbose === true,
      plan: ctx.promptMode === "plan",
    };
  },
});
```

**The icon.** `icon` takes the two shapes of `bb.branding.icon` — a named
host glyph (`"Zap"`) or a plugin-relative SVG path (`"./icons/echo.svg"`) —
plus one `bb.branding.icon` itself refuses: one of the plugin's declared
icons by its namespaced glyph (`"<pluginId>/<name>"`, an entry of
`bb.branding.experimental_icons`; the plugin id must be this plugin's and
the name declared, else the plugin fails to load). A path-shaped SVG is
served as declared behind `nosniff` and a `default-src 'none'` CSP; it is
not in the manifest, so `bb plugin build` cannot check it — keep it free of
the script vectors the build refuses in a logo. A path or a declared
icon is served to clients as a `logoUrl` and drawn as a `currentColor`
mask, so a monochrome mark follows the bb theme (and the declared
`strings.iconTint`) with no frontend bundle — this is how every provider bb
ships gets its brand mark; core vendors none. A full-colour logo renders as a silhouette. A glyph name carries no
bytes, so there is no `logoUrl` and clients draw the glyph from the shared
icon set. A plugin that wants custom inline React for its mark can still
register `app.slots.experimental_providerIcon({ providerId, icon })` from
an `app.tsx`. Example:

```tsx
// app.tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";

function EchoIcon({ className }: { className?: string }) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" className={className}>
      <path d="…" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({
    providerId: "echo-agent",
    icon: EchoIcon,
  });
});
```

(The four first-party provider plugins ship no `app.tsx`: bb vendors their
marks itself, so an icon-only bundle would only add fetches at boot.)

A provider plugin's `app.tsx` loads in the same deferred boot pass as every
other plugin's, whether or not one of its providers is selected: everything
it registers — this icon, a settings section, a nav panel, a palette action,
a pending-interaction form, composer chrome — is present from that pass on,
including on the New Thread page. Until the pass runs the served logo stands
in for the icon. Keep the bundle small; it ships to every window.

Ids are flat and collision-rejected: the first live registration of an id
wins and a later one from another plugin fails that plugin's load; no id is
reserved ahead of time. Registrations replace wholesale on reload like every
other surface. Disabling the plugin removes the provider (open threads show a
provider-unavailable state instead of erroring). The provider picker lists
providers in plugin install order (bundled first-party plugins first); the
user reorders them and picks a default in Settings → Providers
(`bb settings general providerOrder '["my-agent","codex"]'` and
`bb settings general defaultProviderId my-agent`).

`experimental_bridgeOptions` must be a plain JSON object no larger than 64
KiB. It is validated and frozen at registration, then carried on every bridge
request as provider-scoped static options. Use it for immutable launch facts
shared by all hosts, not user settings or machine-local state. It participates
in bridge process identity, so changing it causes the next runtime to use a
new bridge process. `experimental_visibility: "installed"` makes the provider
host-dependent: BB asks that provider's bridge for `provider/health` and lists
it only when the status is not `not_installed`. Such a declaration must support
health; bridge failures hide only that provider.

`deriveProviderOptions` runs synchronously for each session and turn command.
Its plain JSON result has the same 64 KiB limit. The runtime merges the result
over `experimental_bridgeOptions`; a derived key replaces its static key.

### `bb.providers.experimental_contributeEnv` — per-command provider environment

A plugin can contribute environment variables to any provider, including one
registered by another plugin. Register one resolver per provider id:

```ts
bb.providers.experimental_contributeEnv("claude-code", async (context) => [
  {
    name: "ANTHROPIC_BASE_URL",
    value: { serverPath: `/plugins/my-proxy/${context.hostId}` },
    reason: "Route Claude through the plugin's authenticated proxy",
    secret: true,
  },
]);
```

The server calls the resolver for every matching start, resume, fork, and turn
command. Its `ExperimentalPluginProviderEnvContext` has `threadId`, `projectId`,
and `hostId`; return at most 32 `ExperimentalPluginProviderEnvEntry` values.
Names must match `[A-Z_][A-Z0-9_]*`; `reason` and `secret` are required. A
literal `value` is forwarded as-is. `{ serverPath: "/..." }` is expanded by
the selected host against its authenticated `BB_SERVER_URL`, which is the
right form for a server route that must work from enrolled machines.

Contributions override the host shell environment. If multiple plugins return
the same name, the earlier registration wins and BB logs the conflict. A
resolver that throws, times out after five seconds, or returns invalid entries
contributes nothing for that command without blocking other plugins. Mark
credentials and sensitive URLs with `secret: true`; BB passes the real value
to the provider but masks it in `provider.env-resolved` timeline events.

When the contributed environment supplies credentials that replace a local
login, pair the resolver with
`bb.providers.experimental_contributeEnvHealth(providerId, resolve)`. Its
host-scoped `ExperimentalPluginProviderEnvHealthContext` contains `hostId`.
Return an `ExperimentalPluginProviderEnvHealth` `{ label, statusMessage }` only
while the proxy is usable, or `null` otherwise. BB uses it only when the
provider bridge reports `unauthenticated` or `expired`, and only when the same
plugin registered an env resolver for that provider. Installation and unknown
failures are preserved.

Use `extensionKinds` to declare provider-specific item or state payloads. Each
kind needs an item schema, a state schema, or both. The server validates each
payload at ingest. It persists an unhandled-provider event when validation
fails.

Use `experimental_nativeSkillRoots` and
`experimental_nativeCommandRoots` for fixed host-home or workspace-relative
roots. Each side can have 32 roots. Set `experimental_resolvesNativeRoots`
when the host must inspect local configuration. Implement
`experimental_nativeRootsHostContract` in the host entry. Return absolute
paths with a `user` or `project` origin. Run
`experimental_filterResolvedNativeRoots` before return, so one bad root does
not reject the complete answer. The contract limits each returned side and
applies the correct skill or command shape.

**The bridge.** A provider bridge ships inside the plugin's `bb.host`
artifact — the same artifact a host RPC entry ships in, and a plugin may have
both. Export it by name:

```ts
// host.ts (bb.host)
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine(line) {
    /* one JSON-RPC line from the runtime */
  },
  // Optional; called once before the first line, with this plugin's
  // persistent dataDir and this process's own tempDir.
  start({ pluginId, dataDir, tempDir }) {},
  onClose() {}, // stdin closed: the runtime is gone
  onSigterm() {},
  onSigint() {},
});
```

Do NOT start the bridge yourself: the daemon owns the process boundary (argv,
plugin-scoped directories, bounded stdin framing, signals) and imports this
export out of the artifact. Importing the module must start nothing, which is
also what lets your conformance test drive `handleLine` in-process.

Everything a bridge compiles against is published at
`@get-bb/plugin-sdk/provider-bridge` — protocol schemas including the
`thread/delta` grammar, and the bridge kit — so add `@get-bb/plugin-sdk` to
`dependencies` (not just `devDependencies`): the host builder bundles that
subpath from the plugin's own SDK install, and managed Git installs run
`npm install --omit=dev`, so a devDependency-only SDK is absent when the
artifact is built. This is the exception to the devDependency rule under
"bb.hosts"; the echo example's `package.json` shows the shape. A `bb.host`
artifact cannot import bb's private `@bb/*` workspace packages; an installed
plugin could not resolve them.

The bridge speaks the canonical Provider Bridge Protocol — line-delimited
JSON-RPC 2.0 over stdio, documented in `docs/provider-bridge-protocol.md`.
Minimum correct surface: the `initialize` handshake
(`{protocolVersion, capabilities}`, protocol version 2 — the runtime rejects
any other version at spawn), `thread/start` / `thread/resume` answering
`{providerThreadId}` after a `thread/identity` notification and then a
`session.reset` delta (every session construction is a provider id-space
boundary), `turn/start` driving the delta grammar as batched `thread/delta`
notifications (`input.accepted` → `turn.open` → item/message deltas →
`turn.boundary`), `thread/stop` honoring both intents (`release` must
fabricate nothing), and reply hygiene: unknown method → `-32601`, invalid
params → `-32602` with the issues, never a silent drop. The bridge emits
parsed semantic deltas keyed by provider-native ids (tool-call ids, stream
keys, parent refs); the runtime's delta assembler — never the bridge —
mints every bb turn and item id and constructs the canonical timeline
events.

The runtime can send these requests: `initialize`, `model/list`,
`provider/health`, `provider/usage`, `provider/installation/status`,
`provider/installation/run`, `thread/start`, `thread/resume`, `thread/fork`,
`thread/stop`, `thread/discard`, `thread/name/set`, `thread/archive`,
`thread/unarchive`, `thread/goal/clear`, `turn/start`, `turn/steer`, and
`skills/configure`. A bridge can call `item/tool/call` and
`interaction/request` on the runtime. Bridge notifications are
`thread/delta`, `thread/identity`, `session/replaced`, `provider/raw`,
`provider/recovery`, and `error`. Use the exported method maps and schemas.

The bridge package also exports helpers for JSON-RPC transport, child process
and environment setup, installation and version checks, tool presentation,
bounded output, and recording. Read `provider-bridge-api-index.md` for every
symbol, then read the installed declaration for its exact signature.

For an ACP agent, use `@get-bb/plugin-sdk/provider-bridge/acp`. Re-export
`experimental_acpProviderBridge` as `experimental_providerBridge`. Supply a
validated `acpLaunchSpec` and an ACP dialect in the static bridge options. The
public ACP entrypoint includes the bridge, launch schema, agent probe, model
catalog, tool, and dialect contracts. It supports the `generic`, `cursor`, and
`grok` dialects. Read `provider-bridge-api-index.md` for the complete export
list.

**Conformance.** Ship a test that drives the published kit,
`@get-bb/plugin-sdk/provider-bridge/testing`, against your bridge
in-process: export the bridge surface, wire `experimental_runBridgeConformance`
with your provider id and a transport whose `send` calls it and whose
`takeMessages` drains captured stdout
(`experimental_captureBridgeJsonRpcOutput().takeMessages`; the kit assembles
your `thread/delta` batches itself, through the runtime's real assembler), and
assert every scenario passes (see
`examples/plugins/echo-provider/provider-bridge.conformance.test.ts`). The
same kit assembles your deltas into canonical events, so a second test can
assert what each row becomes
(`examples/plugins/echo-provider/provider-bridge.stream.test.ts`). Never
import a private `@bb/*` package from a plugin: an installed plugin cannot
resolve it.

The test package also provides the production delta assembler, JSON-RPC
harness, calibration checks, and recorded-cell checks. Use these contracts to
test parsing, request replies, semantic timeline output, and error cases.

**Recorded replay.** The same kit ships the regression oracle the first-party
bridges use. Record a real session: start the host daemon with
`BB_PROVIDER_BRIDGE_RECORD_DIR=<dir>` in its environment, run a thread on
your provider, and bb writes `<dir>/<providerId>/<threadId>/<direction>.ndjson`
(a bridge that spawns a CLI also calls `experimental_recordProviderChildIo`
right after `spawn()`). Commit the lanes under your plugin, then replay them in
a test: `experimental_resolveProviderBridgeLaunch({ modulePath, pluginId })`
builds the bridge process exactly as the runtime spawns it,
`experimental_replayRecording` drives the recorded runtime lane into it and
answers its requests with the recorded answers, and
`experimental_compareParity` diffs the assembled events against the
recording's own (`experimental_assembleRecordedEvents`); `experimental_checkRecordedCellReplay`
adds the recorded-cell conformance verdicts. A bridge with a provider child
passes a `ReplayProviderProfile` whose `env` (or `rewriteRuntimeLine`) points
the child at the kit's replay script. When a deliberate bridge change alters
the stream, `experimental_rerecordCurrentBridgeLane` writes the new
expectation beside the recording (`bridge→runtime.current.ndjson`); the
recording itself is never rewritten. See
`examples/plugins/echo-provider/provider-bridge.parity.test.ts`.

**Delivery.** On install/reload the server builds `dist/host.js` and records
its digest. Thread commands for the provider carry `{pluginId, digest}` to the
host daemon, which downloads the bytes from the server, verifies the digest
before caching them, and runs the artifact with its own node — it never
executes unverified bytes. It is one cache and one route with the host RPC
worker, because it is one artifact.
Trust model: installation trust, exactly like every other plugin surface. A
bridge runs only for an installed, enabled plugin, and only on hosts whose
server instructs it.
