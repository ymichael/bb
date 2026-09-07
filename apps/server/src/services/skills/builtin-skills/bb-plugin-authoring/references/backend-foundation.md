# Backend foundation

## The backend factory

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  // Register surfaces here. Load-safe: settings, storage, http, rpc,
  // realtime, background, cli, agents, ui, events, status, onDispose.
  // bb.sdk works here in the real server, but prefer it in handlers/services
  // (bind-gated — see below).
}
```

The factory runs at load/reload/enable (time-boxed 30s). A throwing initial
factory puts the plugin in `error` status with the message as the detail; a
throwing reload candidate leaves the prior registration set running and
reports the reload failure in its detail. `bb.pluginId` is the plugin's own id.

The complete top-level factory API is `pluginId`, `log`, `settings`, `storage`,
`http`, `rpc`, `realtime`, `background`, `cli`, `agents`, `providers`, `ui`,
`events`, `status`, `server`, `hosts`, `experimental_aiServices`, `sdk`, and
`onDispose`.

Keyed registrations must be unique within one factory execution: duplicate
settings, routes, rpc methods, services, schedules, CLI registrations, tools,
instruction providers or mention providers are rejected.
Listeners are different: `bb.events.on`, settings `onChange`, and `onDispose`
are additive, so registering multiple listeners is supported.

### bb.log

`bb.log.debug|info|warn|error(message: string)` — goes to the server log
(prefixed `[plugin:<id>]`) and to the per-plugin JSONL file behind
`bb plugin logs <id> [-n N] [-f]`.

### bb.settings

`bb.settings.define(descriptors)` declares settings descriptors (rendered
in Extensions → Plugins and editable via `bb plugin config <id> set <key>
<value>`). Five descriptor types:

```ts
import { z } from "zod";

const settings = bb.settings.define({
  apiKey: { type: "string", label: "API key", secret: true }, // 0600 file, never in db or frontend
  teamKey: { type: "string", label: "Team", default: "" },
  // Multi-line editor (JSON, lists); the value is still a string the plugin
  // parses itself. Cannot be combined with `secret`.
  agents: {
    type: "string",
    label: "Agents",
    experimental_multiline: true,
    experimental_schema: z.string().refine((value) => {
      try {
        return Array.isArray(JSON.parse(value));
      } catch {
        return false;
      }
    }, "Agents must be a valid JSON array"),
    default: "[]",
  },
  retries: {
    type: "number",
    label: "Retries",
    experimental_schema: z.number().int().min(1).max(5),
    default: 3,
  },
  notes: {
    type: "string",
    label: "Notes",
    experimental_schema: z
      .string()
      .max(4096, "Notes must be at most 4096 characters"),
    default: "",
  },
  mode: {
    type: "select",
    label: "Mode",
    options: ["fast", "slow"],
    default: "fast",
  },
  verbose: { type: "boolean", label: "Verbose", default: false },
  project: { type: "project", label: "Project" }, // project picker, stores a proj_* id
});
const { apiKey, teamKey } = await settings.get(); // load-safe; re-read inside handlers for freshness
await settings.experimental_set({ teamKey: "ENG" });
settings.onChange((next, prev) => {
  /* fires after effective values change */
});
```

Typing rule: a descriptor **with** `default` yields a non-optional value
from `get()`; without one the value is `string | number | boolean | undefined`
— so give non-secrets defaults and handle missing secrets explicitly. Number
descriptors accept finite numbers and render a numeric input; use
`experimental_schema` for integer and range constraints.

`experimental_schema` accepts a synchronous, non-transforming Standard Schema
validator; Zod schemas qualify. It runs on the server for settings-page
autosaves, `bb plugin config`, `experimental_set`, and fake-host writes. The
first validation issue is shown beneath the field, and the schema is not sent
to the browser. `experimental_set` accepts only the fields defined by that
handle, accepts `null` to unset one, fires `onChange`, and returns the handle's
effective values.

### bb.storage

- `bb.storage.kv` — namespaced JSON key-value rows in bb.db:
  `get<T>(key)`, `set(key, value)`, `delete(key)`, `list(prefix?)`. Values
  are capped at **256KB each** — kv is for cursors, links, and small state;
  caches and datasets go in the plugin database.
- `bb.storage.database()` — the plugin's own better-sqlite3 database at
  `<dataDir>/plugins/<id>/data.db` (WAL, busy_timeout 5000). Handles are
  host-tracked and closed on reload; a closed handle throws.
- `bb.storage.migrate(db, statements)` — statement index = migration id;
  unapplied statements run in one transaction. **Append-only**: never
  reorder or edit shipped statements, only push new ones.

```ts
const db = bb.storage.database();
bb.storage.migrate(db, [
  `CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
]);
```

### bb.server

Read-only facts about the running server. `bb.server.loopbackBaseUrl` is the
server's own loopback base URL (e.g. `http://127.0.0.1:38886`), which serves
the SPA + `/api` + `/ws` — for plugins that proxy or relay traffic back to
the server itself (the builtin connect plugin's tunnel is the canonical
user). **Bind-gated** like `bb.sdk`: reading it before the server is
listening throws, so prefer reading it from handlers, services, and timers.
`bb.server.experimental_appUrl` gives the operator-configured public app URL,
or `null` when `BB_APP_URL` is empty. It is not bind-gated.
`bb.server.experimental_dataDir` gives the exact server data directory for a
migration from BB-managed files. Do not write plugin state there. Use
`bb.storage` for plugin-owned state.

### bb.hosts

For a plugin with a singular `bb.host` entry, define one runtime contract
shared by the server and host modules:

```ts
// contract.ts
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  setEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
});

export const hostSignals = {
  changed: {
    payload: z.object({ reason: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;
```

The host entry default-exports its implementation:

```ts
// host.ts
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    setEnabled: async ({ enabled }, context) => {
      await setEnabled(enabled, context.signal);
      await context.experimental_emitSignal("changed", {
        reason: "setting-applied",
      });
      return { enabled };
    },
  },
  dispose: async () => closeChildren(),
});
```

`experimental_defineHostEntry` adds the required `experimental_apiVersion: 1`.
Do not construct the entry object without this helper.

The server factory calls only its own host entry:

```ts
const host = bb.hosts.experimental_client({
  contract: hostContract,
  experimental_signals: hostSignals,
});
const result = await host.call(
  "setEnabled",
  { enabled: true },
  { hostId, signal },
);
const unsubscribeWorkerExit = host.experimental_onWorkerExit(({ hostId }) => {
  // Reassert durable desired state; the next call starts a fresh worker.
});
const unsubscribeChanged = host.experimental_onSignal(
  "changed",
  ({ hostId, payload }) => {
    // Invalidate or reread server state for this host.
  },
);
```

Create the client and register signal handlers in the factory, but call host
methods only after registration completes — from an RPC/event handler,
background service, or timer. Candidate-time calls are rejected because that
generation is not active or fetchable yet.

`context.signal` aborts one call. `context.lifecycle.signal` aborts the whole
worker process on idle eviction, reload, disable, uninstall, or daemon
shutdown. Close timers, sockets, and child processes from the lifecycle signal
and `dispose`.
`context.experimental_paths.dataDir` is persistent and scoped to this plugin on
the targeted daemon; `tempDir` is deleted with the worker process.
`context.experimental_watch(options, listener)` uses the daemon's native file
watcher. Deliveries are coalesced and serialized while the listener is busy;
on `rescan-required`, reread current state instead of trusting prior events.
Subscriptions are disposed with the worker and can also be disposed directly.
Active calls and native watches automatically keep the worker running. For
independent background work, acquire a lease during a handler with
`context.experimental_retainWorker()` and dispose it when that work stops.
Lease disposal is idempotent.

Host signals are schema-validated, private to the plugin that owns the host
entry, and ephemeral. Use them as invalidations or progress notifications, not
as durable state; the server callback receives the authenticated `hostId`.
V1 calls still target only an explicit enrolled host. If a method operates on
an environment or directory, resolve it with `bb.sdk` and put the needed id or
absolute path in that method's typed input. Core does not infer an environment,
cwd, or lock for host RPC.

The worker is lazy and reusable; there is no short-/long-lived manifest flag.
After five minutes with no active call, native watch, or retained lease, the
daemon gracefully stops it. A later call starts it again. This idle stop does
not emit `experimental_onWorkerExit`. A crash fails in-flight calls, emits
`experimental_onWorkerExit` to the active server generation, and a later call
starts a fresh worker. Graceful reload, disable, uninstall, and daemon shutdown
do not emit it. The event is ephemeral, so long-lived plugins must also
reconcile when their target host reconnects. On reconnect, the daemon keeps
workers whose generation is still active and disposes generations disabled or
replaced while it was offline. There is no global worker-count limit. Host code
receives the normalized user `PATH` without daemon-owned `BB_*` variables.

Host limits protect the daemon:

- A worker starts within 10 seconds and stops after five idle minutes.
- One plugin can have 256 active calls and 32 MiB of active call input.
- Each host RPC input and output can contain at most 8 MiB of JSON.
- A call uses a 30-second default timeout and a five-second cancellation grace.
- A worker can have 256 watches and 4,096 ignore entries per watch.
- A watch path can contain 16 KiB; a watch batch can contain 1 MiB.
- A watch batch can contain 4,096 changed paths.
- The debounce range is 10–5,000 ms; the maximum wait is 30 seconds.
- The host artifact can contain at most 256 MiB.
- The host dispose hook has five seconds to finish.

These single-worker, idle-eviction, retention, and call-timeout rules describe
the host RPC consumer only. Another daemon subsystem may attach the same
`bb.host` artifact through a different bootstrap and own a separate process
lifecycle.

Host production code may import public `@get-bb/plugin-sdk` entrypoints, Node
APIs, and ordinary third-party dependencies. It must not import private
monorepo packages such as `@bb/domain`, `@bb/host-workspace`, or any other
`@bb/*` package; the host artifact build rejects those imports anywhere in its
dependency graph, including type-only imports and relative paths that resolve
into a private package. Keep shared contract types plugin-local and validate
them at the RPC boundary.

Where `@get-bb/plugin-sdk` goes in `package.json` depends on what the host
entry imports. A host entry that uses only the root helpers
(`experimental_defineHostEntry`, `defineRpcContract`,
`PLUGIN_CLI_OUTPUT_MAX_BYTES`) keeps the SDK in exact `devDependencies`: the
host builder stubs those helpers and bundles them into the self-contained
artifact, including for managed Git installs, which run
`npm install --omit=dev`. A host entry that imports
`@get-bb/plugin-sdk/provider-bridge`, `@get-bb/plugin-sdk/ai-services`, or a
published `@get-bb/plugin-sdk/host` contract such as
`experimental_nativeRootsHostContract` is bundled from the plugin's own SDK
install, so that plugin lists the SDK under `dependencies` (see
"bb.providers.register — agent providers" below; every provider plugin in
bb does this). Either way the daemon never resolves the SDK or private BB
packages from the plugin at runtime.

Pure JavaScript dependencies are bundled. For external tools, use
`child_process` to probe or invoke tools on `PATH`. bb V1 provides no
privileged package installer; a plugin that invokes a system installer owns
user consent, elevation, platform-specific behavior, and recovery.

The rest of `bb.hosts` controls shared loopback port exposure.

Control-plane declarations for host-local daemon behavior. Use
`bb.hosts.declareSharedPorts(hostId, ports)` to replace this plugin's
desired loopback port set for one host. `ports` contains integers from 1–65535;
the server deduplicates and sorts them, owns the generation, and delivers the
resulting set to the daemon. If an enrolled host is offline, the declaration
stays dormant on the server and is delivered when a credentialed daemon
session reconnects. The call fails with an actionable error if the host has no
bb connect machine enrollment or its connected daemon reports that the local
machine credential is missing.

Call `await bb.hosts.ensureSharedPortTunnel(hostId)` to lazily assign and read
the host's `{ label, baseDomain }` for constructing public URLs. The enrolled
daemon derives both from its trusted gate; plugins cannot choose a domain or
send tunnel identity toward a credential-bearing daemon connection.

Declarations are load-scoped: reload, disable, or shutdown clears them after
the plugin's own dispose hooks run. Plugins do not receive daemon streaming or
socket primitives. Add streaming only for a use case that cannot use bounded
calls, pagination, and lossy invalidation signals.

```ts
const tunnel = await bb.hosts.ensureSharedPortTunnel(hostId);
bb.hosts.declareSharedPorts(hostId, [3000, 4173]);
const url = `https://${tunnel.label}--3000.${tunnel.baseDomain}`;
```
