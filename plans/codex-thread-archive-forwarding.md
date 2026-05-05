# Codex Thread Archive/Unarchive Forwarding

## Goal

Forward `bb thread archive` / `bb thread unarchive` to the Codex app-server so
the underlying Codex thread is also archived/unarchived. Today bb only updates
its own `threads.archivedAt`; Codex then continues to show the underlying
thread in non-archived list/storage views, which is why scripts like
`pnpm codex:archive-tmp-bb-sessions` exist to clean up after the fact.

Resolved probe evidence:

- Archived Codex app-server threads still accept `thread/read`,
  `thread/resume`, and `turn/start` by provider thread id. Forwarding archive
  is not required for future bb commands to work; it is for Codex list/storage
  hygiene.
- Codex `thread/list` hides archived threads unless `archived: true` is
  requested.
- Generated Codex app-server protocol types show
  `thread/archive` takes `{ threadId: string }` and returns `{}`.
  `thread/unarchive` takes `{ threadId: string }` and returns
  `{ thread: Thread }`.
- Restore-safe live probes showed Codex archive/unarchive are not idempotent at
  the protocol layer: duplicate archive returns
  `no rollout found for thread id ...`; duplicate unarchive returns
  `no archived rollout found for thread id ...`. The runtime treats those
  duplicate-state errors as accepted success because bb has already committed
  the local archive state.
- Separate archive cleanup/probe work (`thr_fjav9z98vu`) showed
  `thread/archive` can cascade to AgentControl-spawned Codex descendants. The
  server therefore guards archive forwarding: it skips Codex archive forwarding
  when the bb thread has live child threads or stored provider events show a
  `spawnAgent` tool call. This avoids mutating non-bb Codex child threads
  unintentionally. The local bb archive still succeeds.
- Follow-up review found that `thread.unarchive` must not depend on the
  archived thread's old workspace. Normal managed-environment cleanup can
  destroy that worktree/clone after archive, so unarchive forwarding needs a
  provider-only daemon runtime rooted in a stable daemon-owned maintenance
  workspace.
- Follow-up review found that same-batch `thread.archive` and
  `environment.destroy` commands for a managed environment can race in the
  daemon. The archive command must share the per-environment workspace lane
  with provision/destroy/workspace commands, so the server's queue order
  (archive before cleanup) makes provider archive forwarding complete before
  managed workspace destruction starts.

The straightforward "mirror `thread.rename`" version of this work would
propagate an existing latent bug: `providerThreadId` is optional in the
`AdapterCommand` union, and the codex adapter falls back to bb's `threadId`
when missing. Codex doesn't recognize bb's `thr_…` ids, so that fallback is a
silent misroute. Per AGENTS.md ("optional contract fields are allowed only
when leaving the field out has its own real semantic meaning; do not use
optional fields to hide defaults"), this needs to be fixed before adding more
commands on top.

So this plan has two phases:

- **Phase 1** — tighten the `AdapterCommand` contract so `providerThreadId` is
  required everywhere it has real meaning, and resolve it explicitly at the
  runtime layer (mirror what `stopThread` already does). Net effect: a real
  bug fix for `thread/name/set` and friends.
- **Phase 2** — add `thread/archive` and `thread/unarchive` on the now-clean
  foundation. Resolve `providerThreadId` server-side from the events DB and
  carry it through the daemon command (the pattern `turn.submit` already
  uses), so forwarding works even after a daemon restart that wiped the
  in-memory identity registry.

## Phase 1 — Tighten `AdapterCommand.providerThreadId`

### Why

`packages/agent-runtime/src/provider-adapter.ts:98-147` declares
`providerThreadId?: string` on `thread/resume`, `turn/start`, `turn/steer`,
and `thread/name/set`. The codex adapter then falls back via
`command.providerThreadId ?? command.threadId`
(`packages/agent-runtime/src/codex/adapter.ts:890, 903`). That fallback is
useless in production — codex's `threadId` is a UUID; bb's is `thr_…` —
and it hides the real failure mode. The model already used by
`stopThread` (`runtime.ts:906-913`) is the right one: resolve from the
registry, throw if missing.

### Changes

1. **Update the AdapterCommand union**
   (`packages/agent-runtime/src/provider-adapter.ts:98-147`):
   make `providerThreadId: string` required on:
   - `thread/resume`
   - `turn/start`
   - `turn/steer`
   - `thread/name/set`

   `thread/start` keeps no `providerThreadId` field — that's the only
   genuinely-unknown case (the thread is being created and codex assigns
   the id during the response).

2. **Resolve at the runtime layer** — for each call site that builds one
   of these adapter commands, resolve via the registry and throw if
   missing, exactly like `stopThread` already does:

   - `runtime.ts:314-328` — `reconfigureThreadIfNeeded` building
     `thread/resume`.
   - `runtime.ts:720-734` — `resumeThread` building `thread/resume`.
   - `runtime.ts:795-808` — `runTurn` building `turn/start`.
   - `runtime.ts:869-883` — `steerTurn` building `turn/steer`.
   - `runtime.ts:960-965` — `renameThread` building `thread/name/set`.

   Extract the resolution into a small helper to avoid copy/paste:

   ```ts
   function requireProviderThreadId(threadId: string): string {
     const id = threadIdentityRegistry.getProviderThreadId(threadId);
     if (!id) {
       throw new Error(`No provider thread id available for ${threadId}`);
     }
     return id;
   }
   ```

   Note: `resumeThread` (line 720) has a slightly more involved flow — it
   may also accept a `providerThreadId` from the caller and may receive
   one back from the provider. The existing `if (!resolvedId) throw` at
   line 758 already handles the resume-result case; the pre-send adapter
   command construction at line 724 needs to fall back to
   `requireProviderThreadId` instead of allowing `undefined` through.

3. **Drop the `?? command.threadId` fallbacks**
   (`packages/agent-runtime/src/codex/adapter.ts:890, 903`):
   change to just `command.providerThreadId`. Once the union requires the
   field, TypeScript guarantees it's a string.

4. **Other adapters** — `claude-code/adapter.ts`, `test/fake-adapter.ts`,
   any other `buildCommandPlan` implementations: same change. Find with
   `grep -n "providerThreadId ??" packages/agent-runtime/src`.

5. **Tests** —
   - `packages/agent-runtime/src/runtime.command-contract.test.ts`: add
     coverage for the throw path on each of the four runtime methods
     when the thread is unknown to the registry.
   - Existing tests that pass `undefined` (or omit the field) for
     `providerThreadId` will fail to typecheck — update them to either
     register a provider thread identity first (the realistic case) or
     pass the expected string.

### Latent bug fix this exposes

Today, calling `runtime.renameThread({ threadId, title })` for a bb
thread the runtime has forgotten (post-`forgetThread` or post-restart)
silently sends `{ threadId: "thr_…" }` to codex, which codex ignores.
After Phase 1, that case throws — surfaces a real failure mode, and
forces Phase 2's design (carry the resolved id through the daemon
command) for any new caller that needs to work after a restart.

## Phase 2 — Add archive/unarchive forwarding

Builds on Phase 1's clean contract. From day one, the new
`thread/archive` and `thread/unarchive` adapter commands carry a
**required** `providerThreadId`. Archive commands carry the original
`workspaceContext` because the archive command may run before cleanup.
Unarchive commands are provider-only at the daemon boundary: they carry
`providerId`, `providerThreadId`, and `threadId`, but not the archived
thread's old `workspaceContext`. The daemon uses a stable maintenance runtime
under `dataDir` for provider-only unarchive execution.

### Why server-side resolution

Archive runs long after a thread was last active. The runtime registry
is populated lazily and cleared on `forgetThread`/restart, so it can't
be relied on for archive. The events table always has the
`providerThreadId` recorded (via `getLastStoredProviderThreadId` in
`packages/db/src/data/events.ts:669`), so the server can resolve it
deterministically and bake it into the daemon command. The daemon command also
carries workspace context so archive/unarchive can recreate the environment
runtime after a daemon restart — the same pattern `turn.submit` already uses
for `resumeContext.providerThreadId`
(`packages/host-daemon-contract/src/commands.ts:96-97, 141-148`).

### Changes

#### 1. Capability flag

`packages/domain/src/provider-types.ts:21-26` — extend
`providerCapabilitiesSchema` with `supportsArchive: z.boolean()`.

`packages/agent-providers/src/catalog.ts:39-55`:
- `CODEX_CAPABILITIES.supportsArchive = true`
- `CLAUDE_CAPABILITIES.supportsArchive = false`
- `PI_CAPABILITIES.supportsArchive = false`
- `cloneCapabilities()` at line 169 also has to copy the new field.

`packages/agent-providers/test/catalog.test.ts:17-38` — update the
expected capability shapes.

#### 2. AdapterCommand union

`packages/agent-runtime/src/provider-adapter.ts:98-147` — add two
variants. Both have a required `providerThreadId` from the start:

```ts
| {
    type: "thread/archive";
    threadId: string;
    providerThreadId: string;
  }
| {
    type: "thread/unarchive";
    threadId: string;
    providerThreadId: string;
  }
```

#### 3. Codex adapter

`packages/agent-runtime/src/codex/adapter.ts:797-906` — add two cases
next to `thread/name/set`:

```ts
case "thread/archive":
  if (!capabilities.supportsArchive) {
    return { kind: "noop", reason: "archive unsupported" };
  }
  return {
    kind: "request",
    method: "thread/archive",
    params: { threadId: command.providerThreadId },
  };
case "thread/unarchive":
  // symmetrical
```

`packages/agent-runtime/src/claude-code/adapter.ts:756, 921` and
`packages/agent-runtime/src/test/fake-adapter.ts:60-122` need matching
cases (claude-code returns `noop`; fake-adapter records the command).

#### 4. Runtime API

`packages/agent-runtime/src/types.ts:166` — add to the `Runtime`
interface:

```ts
archiveThread(args: ArchiveThreadArgs): Promise<void>;
unarchiveThread(args: UnarchiveThreadArgs): Promise<void>;
```

Both args carry `{ threadId: string; providerId: string; providerThreadId:
string }` — the caller is required to pass the stored provider identity.

`packages/agent-runtime/src/runtime.ts:953-985` — add `archiveThread` /
`unarchiveThread` methods next to `renameThread`. Each:

1. `ensureProvider({ providerId })` using the caller-provided provider id.
2. `requireProviderProcess(providerId)` to ensure the codex process is
   alive.
3. Gate on `proc.adapter.capabilities.supportsArchive` (throw with the
   same shape as the rename gate at line 956).
4. Build the AdapterCommand using the **passed-in** `providerThreadId`.
   No registry lookup for either provider id — that's deliberate; the server
   already did it.
5. `requireProviderRequestPlan(...)` + `sendJsonRpcRequest(...)`.
6. `emitAcceptedCommandEvents(...)` for downstream observability.

#### 5. Host-daemon command contract

`packages/host-daemon-contract/src/commands.ts`:

- Bump `HOST_DAEMON_PROTOCOL_VERSION` (currently `12` on this branch after the
  provider-only unarchive follow-up).
- Add `"thread.archive"` and `"thread.unarchive"` to
  `HOST_DAEMON_COMMAND_TYPES` (line 29).
- Add schemas — both carry required `workspaceContext`, `providerId`, and
  `providerThreadId`, mirroring the `interactive.resolve` pattern
  (line 185-193) which also carries one:

```ts
export const threadArchiveCommandSchema = hostDaemonThreadWorkspaceTargetSchema
  .extend({
    type: z.literal("thread.archive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
  });
export const threadUnarchiveCommandSchema = hostDaemonThreadWorkspaceTargetSchema
  .extend({
    type: z.literal("thread.unarchive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
  });
```

- Add both to `hostDaemonNonProvisionCommandSchema` discriminated union
  (line 367).
- Add both to `shouldFlushEventsBeforeReportingCommandResult`'s `false`
  branch (line 421) — same as rename.
- Add result schemas in `hostDaemonCommandResultSchemaByType` (line 447):
  `"thread.archive": z.object({})`, `"thread.unarchive": z.object({})`.

#### 6. Server queue helpers

`apps/server/src/services/threads/thread-commands.ts:138-368` — add:

```ts
export interface QueueThreadArchiveCommandArgs {
  environment: ThreadWorkspaceCommandEnvironment;
  providerThreadId: string;
  thread: Thread;
}

function providerSupportsThreadArchive(providerId: string): boolean {
  if (!isAgentProviderId(providerId)) return false;
  return getBuiltInAgentProviderInfo(providerId).capabilities
    .supportsArchive;
}

export function queueThreadArchiveCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueThreadArchiveCommandArgs,
): void {
  if (!providerSupportsThreadArchive(args.thread.providerId)) return;
  const workspaceContext = buildThreadWorkspaceContext(args.environment);
  if (!workspaceContext) return;
  const session = getActiveSession(deps.db, args.environment.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: args.environment.hostId,
    sessionId: session?.id ?? null,
    type: "thread.archive",
    payload: JSON.stringify({
      type: "thread.archive",
      environmentId: args.environment.id,
      threadId: args.thread.id,
      workspaceContext,
      providerId: args.thread.providerId,
      providerThreadId: args.providerThreadId,
    }),
  });
}
// queueThreadUnarchiveCommand: symmetrical
```

Note: rename's gate falls through to `true` for non-agent providers
(line 152). Archive should default to `false` — there are no other
provider classes that support archive today, and silently fanning a
`thread.archive` to an unknown provider is worse than a no-op.

#### 7. Server route wiring

`apps/server/src/routes/threads/actions.ts:178-217` (archive route):
before `archiveThread(deps.db, deps.hub, thread.id)` prunes history, resolve
the provider thread id. After the local archive succeeds and **before**
`requestEnvironmentCleanup` is called, enqueue if the provider supports archive
and the cascade guard allows it:

```ts
const providerThreadId = getLastProviderThreadId(deps, thread.id);
if (providerThreadId) {
  queueThreadArchiveCommand(deps, {
    environment: {
      id: environment.id,
      hostId: environment.hostId,
      path: environment.path,
      workspaceProvisionType: environment.workspaceProvisionType,
    },
    providerThreadId,
    thread,
  });
}
```

`apps/server/src/routes/threads/actions.ts:219-223` (unarchive route):
load the public thread, resolve the provider thread id, and enqueue
`queueThreadUnarchiveCommand` when the thread still has an environment row.

Both routes still return `{ ok: true }` even if the queue helper no-ops
(no environment, no providerThreadId, provider doesn't support archive, or
archive cascade risk).
The codex sync is best-effort — bb is the source of truth.

#### 8. Daemon dispatch

`apps/host-daemon/src/command-dispatch.ts:186-199` — add two handlers
mirroring `"thread.rename"`:

```ts
"thread.archive": async (
  command: Extract<HostDaemonCommand, { type: "thread.archive" }>,
  options: CommandDispatchOptions,
) => {
  const entry = await requireWorkspaceEnvironment(
    {
      environmentId: command.environmentId,
      workspaceContext: command.workspaceContext,
    },
    options.runtimeManager,
  );
  await entry.runtime.archiveThread({
    threadId: command.threadId,
    providerId: command.providerId,
    providerThreadId: command.providerThreadId,
  });
  return {};
},
// thread.unarchive: symmetrical
```

#### 9. Tests

- `packages/agent-runtime/src/runtime.command-contract.test.ts` — add
  archive/unarchive cases mirroring rename. Verify the JSON-RPC request
  method is `thread/archive` / `thread/unarchive` and that the params
  carry the passed-in `providerThreadId` (not the bb threadId).
- `apps/host-daemon/test/command/dispatch-helpers.ts:229` (fake runtime)
  — add `archiveThread` / `unarchiveThread` stubs that record
  invocations.
- `apps/host-daemon/test/command/thread-dispatch.test.ts` — add
  dispatch tests asserting the runtime methods are called with the
  pass-through `providerThreadId`.
- `apps/server/test/public/` — route tests asserting that:
  - archiving a codex-backed thread with recorded events enqueues
    `thread.archive` with the resolved `providerThreadId`
  - archiving a codex-backed thread with no events does NOT enqueue
    (silent skip)
  - archiving a non-codex thread (claude-code, pi) does NOT enqueue
- Verify the existing archive route test still passes — the new
  behavior is additive.

## Open questions to resolve during implementation

1. **Codex idempotency.** Resolved. Duplicate archive/unarchive state returns
   errors, not no-op success. Runtime downgrades only the observed duplicate
   state messages to accepted success.
2. **`thread/unarchive` shape.** Resolved from generated Codex protocol types
   and live probe: method is `thread/unarchive`, params are `{ threadId }`, and
   success returns `{ thread }`.
3. **Cleanup-vs-forward ordering.** Resolved. Resolve the provider thread id
   before pruning, queue the daemon command after the local archive and before
   environment cleanup, and run `thread.archive` in the daemon's
   per-environment workspace lane so same-batch cleanup cannot destroy the
   runtime/workspace before provider archive forwarding finishes.
4. **Protocol version bump.** Resolved by bumping
   `HOST_DAEMON_PROTOCOL_VERSION` to 12 across the archive/unarchive command
   additions and provider-only unarchive follow-up. `/session/open` validates
   the daemon-reported protocol version against the bumped literal, so old
   daemons cannot open a new session against this server after reconnect.
5. **Cascade semantics.** Resolved. Codex archive can cascade to
   AgentControl-spawned descendants, so archive forwarding is guarded and
   skipped when live bb children or stored `spawnAgent` tool-call evidence are
   present.
6. **Should rename also migrate to server-resolved
   `providerThreadId`?** Phase 1 keeps rename's resolution at the
   runtime layer (registry + throw). That's fine for the common case
   where the runtime is hot, but reproduces the post-restart problem
   archive is solving for. Consider a Phase 1.5: add `providerThreadId`
   to `threadRenameCommandSchema` too, resolve server-side in
   `queueThreadRenameCommand`, drop the registry lookup from
   `runtime.renameThread`. Symmetric, and removes one more reason for
   the runtime to rely on stale registry state. File as a follow-up if
   we don't include it here.

## Validation

1. `pnpm exec turbo run typecheck --filter=@bb/domain
   --filter=@bb/agent-providers --filter=@bb/agent-runtime
   --filter=@bb/host-daemon-contract --filter=@bb/server
   --filter=@bb/host-daemon`.
2. `pnpm exec turbo run test --filter=@bb/agent-runtime --force`,
   `--filter=@bb/host-daemon --force`, `--filter=@bb/server --force`,
   and `--filter=@bb/agent-providers --force`, each piped to a file per
   the AGENTS.md slow-test rule.
3. Source/probe evidence instead of browser/manual validation:
   generated Codex app-server types for archive/unarchive shapes,
   restore-safe live Codex probes for duplicate-state errors, archived-thread
   command handling, `thread/list` behavior, and cascade behavior.
4. `git diff --check`.

## Exit criteria

- `bb thread archive <id>` of a codex-backed thread results in the
  matching codex thread row having `archived = 1` in the codex state
  DB, with no manual `pnpm codex:archive-tmp-bb-sessions` follow-up
  needed, unless the cascade guard skips forwarding.
- `bb thread unarchive <id>` reverses it.
- Archiving a non-codex thread (claude-code, pi) succeeds locally and
  enqueues no daemon command.
- Archiving a codex thread that never produced an event succeeds
  locally and enqueues no daemon command (silent skip, not error).
- Archiving a codex thread with live bb children or stored `spawnAgent`
  provider events succeeds locally and enqueues no daemon command.
- `AdapterCommand` no longer has any optional `providerThreadId` for
  commands where one is semantically required; codex/claude-code
  adapters no longer fall back to bb's `threadId`.
- All existing tests still pass; new tests cover the codex/non-codex
  branching, the providerThreadId pass-through, and the runtime throw
  path on missing identity.
- Same-batch `thread.archive` and `environment.destroy` commands for the same
  environment are serialized so archive forwarding finishes before destroy
  starts.

## Delete this plan when

- All exit criteria pass and the change is merged.
