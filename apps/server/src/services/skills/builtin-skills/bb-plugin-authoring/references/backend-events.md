# Events, HTTP, RPC, realtime, and background work

### bb.events.on — lifecycle events

```ts
bb.events.on("thread.created", ({ thread }) => { ... });
bb.events.on("thread.active", ({ thread }) => { ... });
bb.events.on("thread.idle", ({ thread, lastAssistantText }) => { ... });   // lastAssistantText: string | null
bb.events.on("thread.failed", ({ thread, error }) => { ... });             // error: string | null
bb.events.on("thread.archived", ({ thread }) => { ... });
bb.events.on("thread.deleted", ({ thread }) => { ... });
bb.events.on("interaction.pending", ({ thread, interaction }) => { ... });
bb.events.on("message.queued", ({ entry }) => { ... });                    // entry: ThreadQueuedMessage
bb.events.on("message.dispatched", ({ entry }) => { ... });
bb.events.on("turn.failed", (event) => { ... });                           // ids + failure facts
```

**Events are announcements core makes.** Something already happened, your
handler is told, and whatever it returns is IGNORED. The surface that ASKS is
`bb.experimental_hooks`, below, where core acts on your answer — the same split
git draws between post-commit and pre-commit hooks.

Ten events. The six `thread.*` ones are thread lifecycle. `interaction.pending`
fires after core commits a pending interaction row. The two `message.*`
ones fire when a dispatch is queued behind a wait, and when a queued row's waits
all clear and it dispatches. Every listener sees every queued row, so a plugin
that only wants its own filters on
`entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId`.
`message.queued` fires again when a row's wait is rewritten, because a row that
moved from one wait to another is news to whoever was waiting on the old one.

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
  if (event.attemptNumber >= 5) return;                  // cap your own retries
  const resetsAt =
    event.rateLimits?.windows.find((w) => w.resetsAtMs !== null)?.resetsAtMs ??
    null;
  await bb.sdk.threads.retry({
    threadId: event.threadId,
    turnRequestId: event.requestId,
    // omit sendAt to attempt now
    ...(resetsAt === null ? {} : { sendAt: resetsAt + 15_000 }),
    reason: "Rate limited",        // shown verbatim on the queued row
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

The six `thread.*` events. `thread.active` fires when an applied lifecycle
transition enters the running `active` state. `thread.archived` fires after a
thread is archived, including cascade archives (archiving a parent archives
its children too, each with its own event). Observe-only handlers run
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
  // ctx.project / ctx.environment / ctx.host, ctx.input.blocks + ctx.input.text,
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

`bb.http.experimental_websocket(path, handler, { auth? })` mounts an
exact-match WebSocket at the same `/api/v1/plugins/<id>/http/<path>` namespace.
The upgrade request uses the same `local`, `token`, and `none` auth modes. A
plain GET does not invoke the WebSocket handler, so an HTTP route and a
WebSocket may share one path. The handler receives the upgrade `request`,
parsed `url`, and `headers`, then returns any of `onOpen`, `onMessage`,
`onClose`, and `onError`. Text arrives as a string and binary data as a
`Uint8Array`. Sockets opened by an old plugin generation close with code 1012
when the plugin reloads or is disabled.

```ts
bb.http.experimental_websocket(
  "/events",
  ({ headers }) => ({
    onOpen(socket) {
      socket.send(`connected:${headers.get("x-request-id") ?? "none"}`);
    },
    onMessage(socket, data) {
      socket.send(data);
    },
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
