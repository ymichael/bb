# Plugin testing and gotchas

## Testing a plugin

### Unit tests with `@get-bb/plugin-sdk/testing`

`@get-bb/plugin-sdk/testing` is the official framework-independent harness for
workspace and standalone plugins. The examples use Vitest. The packed package
ships runtime JavaScript and portable
declarations for all three testing entrypoints. A current scaffold already declares
`@get-bb/plugin-sdk` as an exact devDependency, so the harness is on disk after
`npm install`; an older plugin that still vendors `types/` must add that
devDependency (or run `bb plugin migrate`) before tests can import the harness.
Either way, install its optional peers too: `better-sqlite3` for backend tests,
and React, React DOM, and Testing Library for frontend tests. Add jsdom as a
test-runner development dependency.

The fake plugin host's `bb` satisfies `BbPluginApi` with host-faithful
semantics: real better-sqlite3 temporary storage (never mock the db), the kv
256KB cap, schema-RPC validation/error/strict-JSON behavior, additive events,
keyed registration failures, atomic reload, conditional agent configuration,
request input, typed host-call validation/signal delivery, and `threads.spawn`
plugin attribution.

Backend (`server.ts`) — `createFakePluginHost()`:

```ts
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const { bb, harness } = createFakePluginHost({
  pluginId: "my-plugin",
  settings: { apiToken: "tok" }, // pre-seeded stored values (secrets included)
  sdk: { threads: { spawn: async () => ({ id: "th_1" }) } },
  experimental_callHostRpc: async ({ method, input, hostId, signal }) => {
    return { ok: true }; // validated against the method's output schema
  },
});
await plugin(bb);

const body = JSON.stringify({ event: "test" });
await harness.behavior.callRpc("list", { q: "x" }); // JSON round-trip like the wire
await harness.behavior.fetchHttp("POST", "/events", {
  body,
  headers: { "content-type": "application/json" },
});
const socket = await harness.behavior.experimental_openWebSocket("/v1/echo");
await socket.receive("hello");
socket.sent;
await socket.close();
await harness.behavior.runCli(["search", "x"]); // { exitCode, stdout, stderr }
const svc = harness.behavior.runService("watcher"); // start now; svc.controller.abort(); await svc.done
await harness.behavior.runSchedule("sync"); // no timers, no cron sweep
await harness.behavior.setSettings({ apiToken: "next" }); // validates + fires onChange like a host save
await harness.behavior.resolveAgentConfiguration(
  makePluginAgentConfigurationContext(),
);
await harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: "th_1" }), // complete ThreadResponse fixture
  lastAssistantText: "done",
});
await harness.behavior.callAgentTool("lookup_doc", { query: "x" }); // parse (zod) + execute
await harness.behavior.experimental_emitHostSignal("host-test", "changed", {
  reason: "test",
});
await harness.behavior.experimental_emitHostWorkerExit("host-test");
await harness.lifecycle.dispose(); // abort services, hooks LIFO, close database; stale bb throws
```

The exported `makePluginAgentConfigurationContext`,
`makeMessageDispatchHookContext`, `makeThreadResponse`, `makeQueueEntry`, and
`makeTurnFailedEvent` fixtures return complete deterministic SDK objects with
partial overrides, including nested context members. Use them in behavioral
tests so a new required contract field changes one shared default. Keep schema,
serialization, and command-output fixtures explicit when their exact complete
shape is the assertion.

New tests should use the named views: `harness.behavior` drives host inputs,
`harness.inspection` exposes observable state, and `harness.lifecycle` owns
atomic reload/disposal. Direct members remain aliases for compatibility.
`lifecycle.reload(factory)` preserves settings/KV/database state; a throwing
replacement leaves the current registrations and API live.

Inspect: `harness.inspection.sdk.calls` /
`harness.inspection.sdk.callsTo("threads.spawn")` (every
`bb.sdk` call is recorded; unstubbed methods throw naming the path to stub —
`harness.sdk.stub("projects.list", fn)` adds one late), `harness.logEntries`,
`harness.realtimeSignals`, `harness.experimental_hostRpcCalls`,
`harness.needsConfigurationMessages`, and
`harness.registrations` (HTTP and WebSocket routes, rpc methods, services,
schedules, cli, agent tools/configure provider, mention providers). Pass
`agentSkillIds` to `createFakePluginHost` to declare the manifest skill names
available to the configure driver.

`createFakePluginHost` also accepts `appUrl`, `dataDir`, `loopbackBaseUrl`,
saved settings, SDK method overrides, manifest skill ids, shared-tunnel
identities, host-entry presence, declared icon names, and a host-RPC driver. Inspect
provider and AI-service registrations, host RPC calls, signals, and shared-port
declarations through the harness.

`createFakeSdk` is available separately. Pass a nested `overrides` object.
Inspect all calls or calls to one dot-separated method path. Use `stub` to add
or replace a method after creation. An unstubbed call throws and names the
missing path. The fake adds plugin attribution defaults to `threads.spawn`.

Run `experimental_scanPublicSdkOnly(packageRoot, { allow })` in a package
test. Assert that `violations` and `privateDependencies` are empty. The scanner
checks source and test imports, dynamic import names, relative paths that leave
the package, and private `@bb/*` dependencies. It permits public SDK paths,
Zod, Node modules, package-local files, and declared extra patterns. It skips
`node_modules` and `dist`.

Host entry (`host.ts`) — `@get-bb/plugin-sdk/testing/host`:

```ts
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.js";

const harness = experimental_createHostEntryHarness(hostEntry);

const result = await harness.experimental_call("setEnabled", { enabled: true });
await harness.experimental_dispose();
```

This harness applies the real contract schemas, request and lifecycle
cancellation, JSON round-trips, and the 8 MiB result limit. Supply
`experimental_paths` and an `experimental_watch` adapter when the entry needs
them. Inspect validated signals, the retained-worker lease count, and the
lifecycle signal. Disposal aborts calls and watches before it runs the entry
dispose hook. Worker startup, crashes, artifact verification, and reconnect
behavior belong in daemon integration tests, not this in-process harness.

Frontend (`app.tsx`) — `@get-bb/plugin-sdk/testing/app` (vitest + jsdom):

```tsx
// @vitest-environment jsdom
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

// The thunk matters: app.tsx binds the plugin runtime at module load, so
// loadPluginApp installs the test runtime BEFORE importing it. (For static
// imports, call installTestPluginRuntime() in a vitest setup file instead.)
const app = await loadPluginApp(() => import("./app"));
const contentScripts = await mountPluginContentScripts(app, {
  pluginId: "my-plugin",
  generation: 1,
});

const slot = renderSlot(
  app.navPanels[0]!,
  { subPath: "" },
  {
    rpc: {
      listNotes: () => ({ root: "/notes", notes: [], error: null }),
    }, // method → handler, calls logged
    settings: { greeting: "hi" }, // useSettings() values
    context: { projectId: "p1", threadId: null }, // useBbContext()
    realtimeConnectionState: "reconnecting", // useRealtimeConnectionState()
    openUrl: (url) => url.startsWith("https://"),
  },
);
await slot.findByText("…"); // Testing Library queries
await slot.behavior.setRealtimeConnectionState("connected");
await slot.behavior.setComposerScope(
  { kind: "queued-message", threadId: "t1", queuedMessageId: "q1" },
  "queued draft",
);
slot.inspection.rpcCalls;
slot.inspection.navigateCalls;
slot.inspection.composer; // text, visuals, quotes, mentions, and focus activity
slot.lifecycle.unmount();
await contentScripts.lifecycle.dispose();
```

`loadPluginApp` validates registrations with the host's own rules (slot id
patterns, settingsSection optional title, navPanel path,
fileOpener extensions, and content-script ids/mount functions) and returns
them typed with defaults filled. `mountPluginContentScripts` mirrors ordered
mount, abort-before-cleanup, reverse rollback, exact-once disposal, and
per-window instances. Working examples:
`examples/plugins/slack-bot/server.test.ts` (webhook → kv → recorded spawn →
`thread.idle` reply), `plugins/docs/app.test.tsx` (nav
panel list over rpc + create/open navigation assertions).

Fidelity boundaries: HTTP auth is recorded but not enforced; services and
schedules run only when driven (no restart timers or cron sweep); storage is
process-local and secrets stay in memory; `bb.sdk` is always bound and
unstubbed calls throw; cross-plugin collisions are outside one fake host. The
frontend harness validates SDK registration and synthetic composer behavior.
Its new-thread component does not reproduce host selection reconciliation,
persistence, layout/CSS, routing, crash boundaries, or multi-plugin
arbitration. Use a live loop for those host boundaries.

### Live loop against a running bb

- `bb plugin dev` is the loop: save → rebuild declared `bb.app` and `bb.host`
  artifacts → reload; open app pages pick new UI up live and
  host workers move to the new generation on their next call. Build/reload
  failures print and keep watching. The dev loop writes readable (unminified)
  `dist/app.js` + `app.css`; `bb plugin build` and installs minify them.
- `bb plugin list` shows status, services, schedules (with last_error),
  handler stats, and the CLI command; `bb plugin logs <id> -f` follows
  `bb.log` output. Use `--json` only when live help lists that option.
- Exercise wire surfaces directly: `curl -X POST -H "content-type:
application/json" -d '{}' <server>/api/v1/plugins/<id>/rpc/<method>`,
  `bb <command> …` for the CLI, `bb plugin run <id> …` as the explicit form.
- Keep pure logic in plain functions/modules so it is unit-testable without
  a bb server; the factory file should mostly wire registrations.

BB Official plugins in `plugins/` (a bb checkout):

- `github` — a gh-CLI-backed issue/PR browser in a single navPanel (with
  `headerContent`), subPath-based sub-navigation, shared-ui
  Tabs/Select/DropdownMenu/Badge/Skeleton + sonner toast throughout (in-repo
  plugins import `@bb/shared-ui`; out-of-repo authors vendor the same
  components from the registry), background sync service, rpc + realtime,
  project setting, a `bb github` CLI command, and agent-spawn buttons.
- `docs` (stable plugin id `simple-notes`) — multi-host Docs vaults over
  `bb.sdk.files`, with a Tiptap
  markdown WYSIWYG, nested navigation, images and sandboxed HTML, CLI/HTTP
  operations, autosave with CAS conflicts, native local-vault watching with
  remote polling fallback, a markdown `fileOpener`, message directives, and
  side-panel-only `useComposer()` quote/mention actions.
- `memory` — provider-independent durable agent memory with global/project
  scopes, progressive disclosure, CLI commands, and a Settings editor.

Remaining reference examples in `examples/plugins/`:

- `slack-bot` — headless webhook bot: `auth: "none"` route with signature
  verification, kv thread mapping, `thread.idle` handler, spawn/send,
  needsConfiguration.
- `agent-enrichment` — agent surfaces: CLI command, zod-schema native tool,
  docs mention provider, boolean setting, bundled `skills/` directory.

## Gotchas

- `bb.sdk` is bind-gated: the real server binds it before plugins load, so
  factories can use it there, but isolated harnesses may not — prefer
  handlers, services, and timers.
- kv values cap at 256KB; put caches and datasets in `storage.database()`.
- `storage.migrate` is append-only by statement index.
- Settings saves do not reload healthy or degraded plugins; live `onChange`
  listeners receive those updates. A save automatically retries load when the
  plugin is `needs-configuration`; `bb plugin reload <id>` remains available
  for other recovery cases.
- Descriptors without `default` produce `| undefined` values.
- Thread events are observe-only; there are exactly six
  (`thread.created`, `thread.active`, `thread.idle`, `thread.failed`,
  `thread.archived`, `thread.deleted`).
- Service throw of NeedsConfigurationError changes plugin status; schedule
  throws only set the schedule's last_error. Name-matching means no import
  is needed for the error class.
- Schedules only fire while the plugin is loaded (rows are durable, the
  runner is not).
- CLI `run(argv)` argv excludes the command name; core bb command names
  are reserved; workspace-sandboxed agent threads (Accept Edits / Approve
  for me) may fail to reach the bb CLI when the provider sandbox blocks
  loopback network (Claude's macOS sandbox permits it; Linux and other
  providers may not).
- Mention `search` is 2s-time-boxed; mention `resolve` runs at send time
  and a throw blocks the send.
- Agent tool and instruction changes apply on the next session start, not
  mid-session; cross-plugin tool-name collisions drop the later registration.
- RPC results must be strict JSON values and pass their output schema;
  realtime payloads must survive JSON.stringify.
- Handler stats shown by `bb plugin list` persist across reloads (reset on
  remove).
- The frontend Tailwind pass emits default-theme utilities only — style
  with host token classes, no custom `@theme` colors, no hand-set oklch.
- `onDispose` hooks run LIFO; stale `bb` handles from before a reload throw
  on use.
- Backend API imports normally remain type-only. The root runtime exports
  `defineRpcContract`, `experimental_defineHostEntry`, and
  `PLUGIN_CLI_OUTPUT_MAX_BYTES`; validator imports are plugin dependencies. The
  scaffold tsconfig typechecks both `server.ts` and `app.tsx`.
- The declarations you read are pinned to one SDK version, not a live view:
  new plugins get them from the exact `@get-bb/plugin-sdk` devDependency, older
  ones from a vendored `types/*.d.ts` copy. Run `bb plugin types` before
  trusting either — it repins the devDependency or rewrites `types/` as
  appropriate — and never fall back to a minified `dist/` bundle — see
  "Looking up the exact API". `bb plugin migrate` moves an older plugin off the
  vendored copy, but only when the user asks for it.
