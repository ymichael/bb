# Events, HTTP, RPC, realtime, and background work

### bb.events.on — lifecycle events

```ts
bb.events.on("thread.created", ({ thread }) => { ... });
bb.events.on("thread.active", ({ thread }) => { ... });
bb.events.on("thread.idle", ({ thread, lastAssistantText }) => { ... });   // lastAssistantText: string | null
bb.events.on("thread.failed", ({ thread, error }) => { ... });             // error: string | null
bb.events.on("thread.archived", ({ thread }) => { ... });
bb.events.on("thread.unarchived", ({ thread }) => { ... });
bb.events.on("thread.deleted", ({ thread }) => { ... });
bb.events.on("interaction.pending", ({ thread, interaction }) => { ... });
bb.events.on("message.queued", ({ entry }) => { ... });                    // entry: ThreadQueuedMessage
bb.events.on("message.dispatched", ({ entry }) => { ... });
bb.events.on("turn.failed", (event) => { ... });                           // ids + failure facts
bb.events.on("message.cancelled", ({ entry }) => { ... });                 // row deleted before dispatch
```

**Events are announcements core makes.** Something already happened, your
handler is told, and whatever it returns is IGNORED. The surface that ASKS is
`bb.experimental_hooks`, below, where core acts on your answer — the same split
git draws between post-commit and pre-commit hooks.

Twelve events. The seven `thread.*` ones are thread lifecycle. `interaction.pending`
fires after core commits a pending interaction row. The three `message.*`
ones fire when a dispatch is queued behind a wait, when a queued row's waits
all clear and it dispatches, or when the queued row is cancelled. Every listener sees every queued row, so a plugin
that only wants its own filters on
`entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId`.
`message.queued` fires again when a row's wait is rewritten, because a row that
moved from one wait to another is news to whoever was waiting on the old one.

`message.cancelled` fires when the user removes a queued row before it ever
dispatched — the only signal for that removal. A plugin holding external
resources for a waiting message (a sandbox mid-provision via an environment
provider, a reserved slot) releases them here; archive/delete of the whole
thread fires the thread event instead.

`turn.failed` fires after a turn failed and the thread has already landed in
`error`. Its payload (`PluginTurnFailedEvent`) is ids and failure facts only —
`threadId`, the failed turn's `requestId`, the provider `turnId` (null when the
failure never reached a turn), `errorInfo` (the failure's `ProviderErrorInfo`:
the provider's own report, or the typed code of a request the provider rejected
at the door; null when neither carried one), `inputAccepted` (whether the
provider took the input into its conversation before failing), `rateLimits`
(the latest `ProviderRateLimitState`, null when the provider reports no
windows) and `attemptNumber` (1 on a first failure, 2 on the first retry's).
There is no thread DTO and no copy of the message, because a retry is asked for
BY REFERENCE:

```ts
bb.events.on("turn.failed", async (event) => {
  if (event.errorInfo?.category !== "rate-limit") return;
  if (event.attemptNumber >= 5) return; // cap your own retries
  const resetsAt =
    event.rateLimits?.windows.find((w) => w.resetsAtMs !== null)?.resetsAtMs ??
    null;
  await bb.sdk.threads.retry({
    threadId: event.threadId,
    turnRequestId: event.requestId,
    // omit sendAt to attempt now
    ...(resetsAt === null ? {} : { sendAt: resetsAt + 15_000 }),
    reason: "Rate limited", // shown verbatim on the queued row
  });
});
```

`threads.retry` re-submits the failed turn: the user's message never re-enters
the timeline, and what the provider is sent follows `inputAccepted` — an input
the provider never took is re-sent verbatim, while an accepted turn (already in
the provider's conversation) is continued with a nudge rather than asked twice.
The new attempt carries a retry marker so the next failure's `attemptNumber` is
right. A future `sendAt`
queues it on the clock; without one it is attempted now. Either way it is an
ordinary dispatch attempt, so it still passes the `message.dispatch` hook. Core
allows one live retry per original turn and enforces no ceiling beyond that —
the cap is yours.

The seven `thread.*` events. `thread.active` fires when an applied lifecycle
transition enters the running `active` state. `thread.archived` fires after a
thread is archived, including cascade archives (archiving a parent archives
its children too, each with its own event). `thread.unarchived` fires after a
thread comes back; nothing is provisioned at that moment — an environment
provider that tore its workspace down is asked for one again when the thread
next needs to run, so this is where to start warming one up. Observe-only handlers run
fire-and-forget after the transition and can never block or veto it. `thread`
is the same DTO `GET /api/v1/threads/:id` serves. Errors are caught, logged,
and counted in the plugin's handler stats (`bb plugin list`).

Lifecycle events are broadcast to all loaded plugins regardless of sidebar
visibility.

`thread.created` fires on row creation, so the first user message is not
always in the timeline yet. To react to a thread's content, listen on
`thread.active` or `thread.idle`, then read the messages with
`bb.sdk.threads.timeline`. Because handlers are fire-and-forget, work you do
in a handler — including `bb.sdk.threads.update({ threadId, title })` —
cannot delay or interrupt the thread's turn.

### bb.experimental_hooks — the dispatch checkpoint

**Hooks are questions core asks.** Core stops, hands your handler a context, and
ACTS ON what you return — the opposite of `bb.events`, whose handlers are told
what already happened. There is ONE hook today, `"message.dispatch"`
(`PluginHookName`), the admission checkpoint every message passes through
exactly once per attempt: a thread's first message, a follow-up, a steer, a
drained queue row, a retry of a failed turn. Two members: `on` answers the
question, and `recheck("message.dispatch")` asks core to ask it again.

```ts
bb.experimental_hooks.on("message.dispatch", (ctx) => {
  // ctx.thread (always present — creation is unhooked, so the row exists),
  // ctx.attempt ("start-turn" | "join-turn"),
  // ctx.project / ctx.environment / ctx.host / ctx.environmentIntent,
  // ctx.input.blocks + ctx.input.text,
  // ctx.requestedExecution, ctx.executionSources, ctx.origin /
  // ctx.originPluginId / ctx.startedOnBehalfOf / ctx.parentThreadId,
  // ctx.queuedMessage (the queued row on a re-attempt, else null).
  if (isBlocked(ctx.input.text)) return { action: "reject", message: "…" };
  if (atCapacity()) return { action: "wait", reason: "4 of 4 running" };
  return { action: "proceed" };
});
```

The context is `MessageDispatchHookContext` (`ctx.attempt` is
`PluginDispatchAttemptKind`, `ctx.input` is `PluginDispatchInput`,
`ctx.requestedExecution` is `PluginDispatchExecution` and `ctx.executionSources`
is `PluginDispatchExecutionSources`); the return value is
`MessageDispatchHookDecision`. `PluginHooks`, `PluginHookSignatures` and
`PluginHookHandler` type the registry itself.

Decisions are `proceed`, `wait` (`reason`, optional `sendAt` epoch ms, which
becomes the row's `sendAt` so core's due sweep re-attempts then) and `reject`
(`message` shown to the user; the caller gets a 409 `dispatch_rejected`). A
handler decides; it never rewrites the dispatch it is deciding about.

A `wait` QUEUES the message as a row whose `waitingOn` names your plugin and
carries your reason verbatim. The row sits in the thread's queue with a card, a
Send-now and a Cancel — the same row a user's own queued message uses.

**Where a wait is visible.** In exactly two places, and neither is the timeline:
the queued card above the composer, which shows your reason, and the thread's
sidebar row, which shows a clock while the thread holds queued work and is not
itself running. Queueing appends no thread event, so a `wait` never writes
anything into the transcript the model or the user reads back.

**How a wait clears.** You never release a row — you ask core to re-decide it.
It clears when the row's `sendAt` comes due, when any plugin calls
`bb.experimental_hooks.recheck("message.dispatch")`, when the user sends it now,
or when the orphan sweep clears a wait whose plugin stopped running. Every one
of those re-runs the full pass, including your own handler, so a message that is
still blocked simply re-queues.

```ts
// The condition your waits depend on changed. Ask core to re-ask.
await bb.experimental_hooks.recheck("message.dispatch");
```

Core owns the re-draining and the clock — `sendAt` due, the thread's own turn
ending, the workspace becoming ready, an interaction settling — and YOU own every
other condition your waits depend on. The walk re-attempts every plugin-queued
row in queue order, running the full hook pass over each, so an unwarranted call
is safe. Bursts coalesce into one walk and per-thread pacing keeps a plugin that
stays blocked from being re-asked in a loop.

### Environment providers: core-owned lifecycle

Register resource operations with `bb.experimental_environments.register`.
`icon` accepts host glyphs, plugin-relative assets, and this plugin's declared
namespaced icons, just like agent providers. The provider listing includes a
hashed `logoUrl` for assets. `app.slots.experimental_providerIcon` can override
an environment or machine provider's icon by its provider ID.

```ts
bb.experimental_environments.register({
  id: "personal-workspace",
  displayName: "Personal workspace",
  icon: "Folder",
  requires: { projectless: true },
  async create({ host, pathKey, report, signal }) {
    report.step("Creating directory");
    const { path } = await client.call(
      "createWorkspace",
      { pathKey },
      { hostId: host.id, signal },
    );
    return { status: "created", path, ownsPath: true };
  },
  async remove({ hostId, path, pathKey, signal }) {
    await client.call("removeWorkspace", { path, pathKey }, { hostId, signal });
    return { status: "removed" };
  },
});
```

`requires` declares four project facts. Every provider runs on the selected
machine; `projectCheckout` requires that machine's project directory; `gitCheckout`
implies `projectCheckout` and requires a committed git checkout; `gitRemote`
supplies the project's remote; `projectless` offers the provider only outside
projects. Projectless cannot combine with project requirements. Core validates
eligibility before creating the thread.
Create waits for startup registrations to settle, then rejects an unknown
provider id; existing threads wait if their registered provider disappears.
`inputs` is an optional Standard Schema validator (including zod);
core parses the request and stores the parsed JSON, with schema defaults filled.
No schema means `inputs: null`. Parsed inputs are persisted on the environment
and are readable by every plugin through the SDK, including after the
environment is destroyed. They are configuration, not a credential store;
keep credentials in secret settings. `availability` may return
available, setup-required with a message, or unavailable with a message for a
project and machine. Core calls it inside the decision timeout and caches the
answer until settings change or the provider calls `recheck`. `validate` may accept or refuse a request
before a thread exists, using the resolved project, host, checkout, remote and
inputs. Required facts and schema outputs are inferred by registration.

Core owns launch attempts, cancellation, retry timing, attachment, retirement,
and removal in SQLite. Providers must not keep duplicate launch records or
call `sdk.environments.delete` to drive retirement. The former
`experimental_defineEnvironmentProvider` runtime and `provision` decision
contract are removed. The environment-provider entry exports operation types.

`create` receives the resolved facts, thread, suggestedBranchName, monotonic
attempt, pathKey, rebuild, `previous: { environment, resource } | null`,
report, and an abort signal. It is one long call and must be idempotent for
pathKey: after a process or plugin restart, core calls it again with the same
attempt and pathKey. Return `created` with `path`, explicit `ownsPath`
and optional `mergeBaseBranch`, or `failed` with terminal/transient and message.
`report.step` and
`report.log` stream durable progress while the call runs.

A created result may carry a private JSON resource capped at
16 KiB. Core transfers it directly to the environment row and never includes
it in responses or events. Rebuild and removal receive it; completed removal
clears it. On cancellation core aborts create, waits for it to stop, then calls
`remove` with nullable `environment`, `hostId` and `path`, plus `pathKey`,
`resource`, `attempt`, `report`, and a new signal. Remove must clean everything
for the pathKey even when create never returned a path, and returns removed or
failed(message).

Policy defaults are normalized at registration: retireGraceMs 5 minutes
(null means never), removeRetryMs 60 seconds, transientRetryMs 30 seconds,
transientRetryLimit 3, pathKeys per-thread (or per-attempt), and createTimeoutMs
null (a positive value aborts and records a transient failure). Rebuilds use
fresh path keys. Retirement starts after the last live thread archives or is deleted.
A per-environment lock serializes removal; failures persist and retry.
Environment responses expose only the read-only lifecycle projection:
phase, retireAt, and teardown status/attempt/message.

### Machine providers: core-owned machines

Register machine resource operations with `bb.experimental_machines.register`.
Machine providers compose with environment providers: a picker sugar row first
creates the machine, then asks its named environment provider for a workspace
on that machine. The Machines page and `bb.sdk.hosts.create` can instead create
a standalone machine with `project: null`; create is not required to enrol a
project source in that case.

`icon` is optional. Omit it when provider-created machines should look like
ordinary enrolled machines: the Machines page and Add machine show neither a
provider logo nor a provider badge. Declaring it enables the normal provider
glyph, plugin-relative SVG, declared icon, or React icon-slot presentation.

```ts
bb.experimental_machines.register({
  id: "custom-machine",
  displayName: "Custom machine",
  icon: "Server",
  inputs: z.object({ target: z.string() }),
  policy: {
    idleSuspendMs: null,
    retire: { after: "never" },
    removeRetryMs: 60_000,
  },
  async create({ project, inputs, key, attempt, report, signal }) {
    report.step(`Connecting to ${inputs.target}`);
    const hostId = await ensureEnrolledHost({
      project,
      target: inputs.target,
      key,
      attempt,
      signal,
    });
    return { status: "created", hostId, resource: { target: inputs.target } };
  },
  async remove({ resource }) {
    await disconnectTarget(resource.target);
    return { status: "removed" };
  },
});
```

`requires.gitRemote` makes the remote non-null when a project is supplied and
filters out projects without one. Optional Standard Schema `inputs` are parsed
before create and persisted in `hosts.machine_provider_selection`. Every plugin
can read them, so never put secrets there. Store credentials in plugin settings
and pass a non-secret reference such as a target name in inputs.

Create receives a nullable project, nullable gitRemote, parsed inputs, a stable
key, monotonic attempt, durable progress reporter, and abort signal. It must be
idempotent by key: if enrolment completed before the server crashed, the next
call returns the already-enrolled host instead of creating another resource.
Return the host id plus a private JSON resource for later lifecycle operations.

Suspend and resume are optional but must be declared together. Without them,
`policy.idleSuspendMs` must be null. With them, core suspends only after every
live thread is idle and no terminal is open, then resumes before the next send.
Suspend receives `checkpoint(resource)`, which synchronously
persists a recoverable private resource before destructive cleanup. Use it
after creating a recovery artifact and before terminating the live machine or
deleting an older artifact. A replay receives the last checkpoint.
Retirement is either last-thread plus a grace period or never. Removal always
cascades through the machine's environment providers before machine remove;
failures persist and retry after `removeRetryMs`.

### bb.http — HTTP routes

`bb.http.route(method, path, handler, { auth? })` mounts an exact-match route
at `/api/v1/plugins/<id>/http/<path>`. The allowed methods are `GET`, `POST`,
`PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. The path must start with `/`.
The router treats `:` and `*` as literal characters, not parameters or
wildcards. The handler is a Hono handler:
`(context) => Response | Promise<Response>`.
Auth modes:

- `"local"` (default) — accepts no `Origin` header or a trusted BB app origin.
  A non-GET mutation must use `application/json`. Use this mode for the BB
  frontend.
- `"token"` — requires the per-plugin token (`bb plugin token <id>`;
  `--rotate` generates a new one, invalidating the old) via the
  `x-bb-plugin-token` header or `?token=`. Right for external scripts
  and machines you control.
- `"none"` — no checks. ONLY for webhooks that verify their own signature
  (e.g. Slack's `x-slack-signature` HMAC) inside the handler.

`bb.http.experimental_websocket(path, handler, { auth? })` uses the same path
namespace and auth modes. A plain GET does not invoke it, so HTTP and WebSocket
routes may share a path. The handler receives `request`, `url`, and `headers`
and returns `onOpen`, `onMessage`, `onClose`, and/or `onError`. Messages are
strings or `Uint8Array`; reload and disable close old-generation sockets 1012.

```ts
bb.http.experimental_websocket(
  "/events",
  ({ headers }) => ({
    onOpen: (socket) => socket.send(headers.get("x-request-id") ?? "none"),
    onMessage: (socket, data) => socket.send(data),
  }),
  { auth: "token" },
);
```

### bb.rpc — the frontend data plane

Define method names plus runtime input/output schemas once, then register
handlers against that contract. Schemas use validator-neutral Standard Schema
v1, which Zod 4 implements directly. The server RPC boundary validates input
before it invokes the handler. It validates output before serialization.
Handler parameters and return values are inferred from the schemas.
Method names can use dot-separated segments with letters, digits, `-`, and `_`.

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  listIssues: {
    input: z.object({ filter: z.string().optional() }).strict(),
    output: z.object({ issues: z.array(z.object({ id: z.string() })) }),
  },
  status: {
    input: z.null(), // null input lets the frontend omit the argument
    output: z.object({ ready: z.boolean() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    listIssues({ filter }) {
      return { issues: listCachedIssues(filter) };
    },
    status() {
      return { ready: true };
    },
  });
}
```

In `app.tsx`, import only the backend contract's type. The backend module and
its dependencies are erased from the frontend bundle:

```tsx
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

function IssuesButton() {
  const rpc = useRpc<typeof rpcContract>();

  async function loadIssues() {
    const { issues } = await rpc.call("listIssues", { filter: "open" });
    return issues;
  }

  return <button onClick={() => void loadIssues()}>Load issues</button>;
}
```

The wire envelope is `{ ok: true, result }` or `{ ok: false, error }`.
Failures use stable codes: `invalid_json`, `invalid_input`, `handler_error`,
`invalid_output`, `non_json_result`, and `unknown_method`; validation failures
also carry normalized `{ message, path? }[]` issues. Unknown methods return
404, invalid JSON/input returns 400, and handler/output/serialization failures
return 500. Results must be strict JSON values: cyclic objects, bigint,
undefined/functions, class instances, symbol keys, and non-finite numbers are
rejected rather than coerced or silently dropped.

### bb.realtime

`bb.realtime.publish(channel, payload)` broadcasts an ephemeral
`{ type: "plugin-signal", pluginId, channel, payload }` message to every
connected client. The channel must be non-empty. V1 has no server-side channel
subscriptions. The frontend hook `useRealtime(channel, handler)` filters the
messages. The payload must be JSON-serializable; `undefined` becomes `null`.
Nothing is persisted. Publish state-change signals and let the frontend
refetch through RPC.

### bb.background — services and schedules

```ts
bb.background.service("worker", {
  async start(signal) {
    while (!signal.aborted) {
      await doWork();
      await sleep(60_000, signal);
    }
  },
});
bb.background.schedule("sync", "*/5 * * * *", async () => {
  await syncNow();
});
```

- A **service** starts after the factory completes and must resolve when
  `signal` aborts (reload/disable/shutdown). A crash restarts it with
  capped exponential backoff.
- A **schedule** is a 5-field cron (server-local time) backed by a durable
  row keyed (pluginId, name) — it survives server restarts, and the sweep
  claims due rows with a compare-and-swap, but it only fires while the
  plugin is loaded.
- Semantics differ on throw: a service throwing `NeedsConfigurationError`
  transitions the whole plugin to `needs-configuration` and stops
  restarting until the next load; a schedule throw (any error) only lands
  in the schedule's `last_status`/`last_error` shown by `bb plugin list`.
- `NeedsConfigurationError` is matched **by name**, so no runtime import is
  needed: `throw Object.assign(new Error(msg), { name:
"NeedsConfigurationError" })`. Pair it with `bb.status.needsConfiguration`
  in the factory so an unconfigured plugin reports itself instead of
  crash-looping:

```ts
const initial = await settings.get();
if (!initial.apiKey)
  bb.status.needsConfiguration(
    "Set apiKey with `bb plugin config <id>`, then reload.",
  );
```
