# Optionality Cleanup Checklist

Remove unexpected optional fields from the public API surface, the server/host-daemon contract boundary, and host-daemon commands. Fields should stay optional only when leaving them out means something real, not when leaving them out just falls back to a hidden default.

## Exit Criteria

- No unexpected optional fields remain in `@bb/server-contract`, `@bb/host-daemon-contract`, or the corresponding route/command payloads.
- The remaining intentional optional fields are limited to query/filter/pagination inputs and `PATCH`-style partial updates, plus a very small explicit list.
- All callers, handlers, and implementations typecheck cleanly and enforce the intended behavior rather than relying on implicit defaults.
- Accepted-but-ignored fields are not allowed. Each one must be deleted or fully implemented end-to-end.
- Product policy lives on the server, not in the host daemon. The daemon only executes explicit server decisions or host-local/provider-local behavior.
- `AGENTS.md` documents the optionality policy so future changes do not reintroduce the same problem.

## Ground Rules

- Optional means leaving the field out has its own business meaning.
- Nullable means explicit empty/cleared/unknown, not “use the default”.
- If a field has a default, fill it in once at the server boundary.
- Internal commands should send explicit values, not missing knobs.
- No field may remain optional if leaving it out only means “whatever today’s default happens to be”.
- No route or command may accept a field it ignores.

## Server And Daemon Split

- The server owns product policy: defaults, instructions, manager behavior, tool lists, and thread behavior.
- The host daemon owns host-local primitives, provider translation, runtime/session management, and workspace execution.
- If the server needs host-local data, the daemon should return the raw data and the server should assemble the final behavior.
- Prefer server changes over daemon changes unless the behavior is inherently host-local or provider-local.

## Expected Final Optional Fields

These are the only kinds of optionals we should expect to keep after this cleanup:

- Public query filters and pagination controls in `public-api.ts`
- `PATCH`-style update keys, including `optional + nullable` when `null` means “clear”
- `CreateThreadRequest.title`
- `CreateThreadRequest.parentThreadId`
- `workspace.list_files.query`
Everything else should be deleted, made required, or filled in by the server before it crosses an internal boundary.

## Recommended Sequence

1. Delete dead or ignored fields first.
2. Make create/send/command intent explicit and update all callers.
3. Fill in execution and diff defaults once, then make downstream fields required.
4. Fix product behavior bugs that were previously hidden by optionality.
5. Update `AGENTS.md` and leave behind a strict allowlist.

## Checklist

### 1. Freeze The Inventory

- [ ] Re-audit every `.optional()` field in `packages/server-contract` and `packages/host-daemon-contract`.
- [ ] For each field, classify it as `keep optional`, `delete`, `fill in the default at the server boundary, then make required`, or `make required`.
- [ ] Add or update tests for every intentional remaining optional field so the meaning of leaving it out is explicit.

### 2. Delete Dead Or Ignored Boundary Fields

- [x] Delete `provider.list_models.environmentId` from the host-daemon command and command payload.
  Purpose: presumably meant to let model availability vary by environment.
  Current: `/system/models` accepts `environmentId` in [apps/server/src/routes/system.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/system.ts#L45) and that query is still useful for picking the correct `hostId` via `resolveHostId()`, but the forwarded command field is ignored by daemon dispatch in [apps/host-daemon/src/command-dispatch.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/command-dispatch.ts#L99). The in-tree app caller in [apps/app/src/lib/api.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/lib/api.ts#L540) never sends `environmentId`.
- [x] Implement `workspace.status.mergeBaseBranch` end-to-end and make it required for status requests.
  Purpose: request workspace status relative to a selected merge-base branch instead of the repo default.
  Current: the app status query can send it in [apps/app/src/lib/api.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/lib/api.ts#L452), the server forwards it in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L36), and archive safety checks already pass `thread.mergeBaseBranch` in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L323). The daemon ignores it and `getStatus()` always uses the default branch in [packages/workspace/src/workspace.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/workspace.ts#L112). Cleanup should update callers to always provide an explicit merge-base branch and make the daemon/workspace honor it.
- [x] Delete `SquashMergeOptions.commitIfNeeded` from the public contract, callers, and UI/CLI copy.
  Purpose: remove a fake behavior toggle. The chosen product behavior is that squash merge always snapshots the source workspace into a real source-branch commit before the squash step.
  Current: the app sends it from the git action dialog in [apps/app/src/components/thread/ThreadGitActionDialog.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/components/thread/ThreadGitActionDialog.tsx#L210), and the CLI sends it in [apps/cli/src/commands/environment.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/environment.ts#L90). The server route never forwards it in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L135).
- [x] Delete `SquashMergeOptions.includeUnstaged` from the public contract, callers, and UI/CLI copy.
  Purpose: remove a fake staging-scope toggle. The chosen product behavior is that squash merge always includes all source workspace changes, not just staged files.
  Current: the app and CLI both send it in the same call paths as `commitIfNeeded`, but the server ignores it on squash-merge and only forwards `targetBranch` and one message field in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L143).
- [ ] Plumb `turn.steer.options` through daemon dispatch, runtime, and provider adapters. Do not leave it accepted-and-ignored.
  Purpose: allow model/reasoning/sandbox overrides on a steer request, using the same default-filling rules as other turn-entry paths.
  Current: the server builds and queues steer execution options in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L137) and [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L236), but daemon dispatch drops them in [apps/host-daemon/src/command-dispatch.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/command-dispatch.ts#L62) because `AgentRuntime.steerTurn()` has no options slot in [packages/agent-runtime/src/types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/agent-runtime/src/types.ts#L102).
- [x] Redesign `CreateProjectSourceRequest` as a discriminated union so invalid partial shapes are no longer representable.
  Purpose: describe valid source creation shapes instead of accepting a loose bag of `type` / `path` / `repoUrl`.
  Current: the schema is loose in [packages/server-contract/src/api-types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/api-types.ts#L164), the server defaults missing `type` to `"local_path"` in [apps/server/src/routes/projects.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/projects.ts#L112), and the only in-tree app caller sends just `{ hostId, path }` in [apps/app/src/components/layout/ProjectList.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/components/layout/ProjectList.tsx#L230). I found no production caller that creates a `github_repo` source through this route.
- [x] Delete `CreateThreadRequest.spawnInitiator` from the public contract.
  Purpose: label the initiator recorded on `client/thread/start` events.
  Current: the public contract exposes it in [packages/server-contract/src/api-types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/api-types.ts#L71), but the only in-tree caller that sets it is the internal tool-call path in [apps/server/src/internal/tool-calls.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/tool-calls.ts#L80). App and CLI thread creation do not send it.
- [x] Delete all user-configurable squash-merge message fields and flags.
  Purpose: remove message customization entirely from squash merge so the API does not expose fake or ambiguous knobs. The prep commit message and final squash commit message should be implementation-owned, not caller-specified.
  Current: the public contract exposes both `commitMessage` and `squashMessage` in [packages/server-contract/src/api-types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/api-types.ts#L198), the CLI can send both in [apps/cli/src/commands/environment.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/environment.ts#L90), the app sends neither in [apps/app/src/views/ThreadDetailView.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/views/ThreadDetailView.tsx#L827), and the server currently collapses them to one daemon `commitMessage`, preferring `squashMessage` over `commitMessage`, in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L148).

### 3. Make Create And Send Intent Explicit

- [x] Make `CreateThreadRequest.input` required in `@bb/server-contract`.
  Purpose: ensure thread creation always includes an initial prompt.
  Current: the app always sends input in [apps/app/src/views/ProjectMainView.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/views/ProjectMainView.tsx#L159), but the CLI `thread spawn` leaves `--prompt` optional and sends `input: undefined` when omitted in [apps/cli/src/commands/thread/spawn.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/spawn.ts#L163). The server treats missing input as “create thread/environment only” in [apps/server/src/services/thread-create.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-create.ts#L156).
- [x] Make `model` required in the public create-thread API. Keep `serviceTier`, `reasoningLevel`, and `sandboxMode` optional on create-thread, with server-owned defaults.
  Purpose: starting a new thread should always choose a model explicitly, while still allowing the API to omit the common defaults for service tier, reasoning level, and sandbox mode.
  Current: `CreateThreadRequest` leaves `model`, `serviceTier`, `reasoningLevel`, and `sandboxMode` optional in [packages/server-contract/src/api-types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/api-types.ts#L71), and server helpers currently accept missing values in [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L23).
- [x] Make CLI `thread spawn --prompt` required so it cannot create an idle thread shell.
  Purpose: align CLI behavior with the intended product model that thread creation starts work immediately.
  Current: `--prompt` is optional in [apps/cli/src/commands/thread/spawn.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/spawn.ts#L101) and is the only in-tree production caller that creates threads without input.
- [x] Make `thread.start.input` required in `@bb/host-daemon-contract`.
  Purpose: ensure daemon `thread.start` always represents “start this thread with this initial turn input”.
  Current: the runtime API supports omitted input in [packages/agent-runtime/src/types.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/agent-runtime/src/types.ts#L74), but current server call sites only queue `thread.start` when input exists in [apps/server/src/services/thread-create.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-create.ts#L169) and [apps/server/src/internal/command-result-handlers.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/command-result-handlers.ts#L191).
- [x] Make `thread.start.eventSequence` required in `@bb/host-daemon-contract`.
  Purpose: tie `thread.start` to a real persisted client event and seed daemon high-water marks correctly.
  Current: the schema allows omission in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L75), but the current server callers that emit `thread.start` always have a real event sequence from `appendClientTurnEvent()` in [apps/server/src/services/thread-create.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-create.ts#L57) or a stored start event in [apps/server/src/internal/command-result-handlers.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/command-result-handlers.ts#L157).
- [x] Make `SendMessageRequest.mode` required and update the app and CLI to always send explicit mode intent.
  Purpose: remove server-side guesswork about whether a user wants start, steer, or auto resolution.
  Current: the server infers when callers omit `mode` via `resolveSendMode()` in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L51). The app follow-up send path omits it, the CLI only ever sends `"steer"` when the user asks in [apps/cli/src/commands/thread/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/actions.ts#L263), and tests cover omitted and invalid combinations in [apps/server/test/public-threads.test.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/test/public-threads.test.ts#L489).
- [x] Make `ArchiveThreadRequest.force` required and update all callers to send `false` or `true` explicitly.
  Purpose: make archive safety bypass explicit instead of inferred from omission.
  Current: the app helper already always serializes a boolean in [apps/app/src/lib/api.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/lib/api.ts#L420), but its wrapper option is optional and the CLI omits the key unless `--force` is passed in [apps/cli/src/commands/thread/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/actions.ts#L142). The server treats omission as `false` in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L323).
- [x] Delete `includeUnstaged` for plain commit actions and make commit always include all workspace changes.
  Purpose: remove staging-scope choice from commit so callers cannot ask for staged-only behavior. Commit should always snapshot the full workspace state.
  Current: the app UI exposes staged-only vs all-changes commit controls in [apps/app/src/components/thread/ThreadGitActionDialog.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/components/thread/ThreadGitActionDialog.tsx#L174), the CLI exposes `--staged-only` for commit in [apps/cli/src/commands/environment.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/environment.ts#L54), the public commit route conditionally forwards `includeUnstaged` in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L103), the daemon command exposes it in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L209), and workspace code currently treats omission as “include everything” in [packages/workspace/src/workspace.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/workspace.ts#L206).

### 4. Fill In Defaults Once, Then Make Internal Fields Required

- [x] Add one server-side helper for thread runtime config. It should fill execution defaults, assemble instructions, and choose tool lists before the server queues daemon commands.
  Purpose: have one place decide runtime behavior instead of letting each path or the daemon invent its own fallback, including active follow-up steer requests.
  Current: `buildExecutionOptions()` just omits missing values in [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L23), draft creation hard-codes `reasoningLevel: "medium"` and `sandboxMode: "danger-full-access"` in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L202), manager creation sets only some fields in [apps/server/src/routes/projects.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/projects.ts#L213), and provider adapters apply their own fallbacks differently.
- [x] Move standard and manager instruction assembly from the host daemon to the server.
  Purpose: make prompt behavior a server-owned product decision instead of daemon-side policy.
  Current: the daemon renders `standardAgentInstructions` and `managerAgentInstructions` in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L10) and [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L137).
- [x] Add a server flow that reads manager `PREFERENCES.md` from the host before queueing manager thread commands.
  Purpose: let the server assemble manager instructions without pushing product policy back into the daemon.
  Current: the daemon reads manager `PREFERENCES.md` locally in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L101).
- [x] Add `instructions` to the host-daemon thread runtime commands and make it required for `thread.start`, `thread.resume`, `turn.run`, and `turn.steer`.
  Purpose: make the daemon execute the instruction text the server chose instead of rendering its own.
  Current: the daemon currently builds instructions internally via `resolveThreadRuntimeConfig()` in [apps/host-daemon/src/command-dispatch.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/command-dispatch.ts#L48), and the host-daemon command schema has no explicit `instructions` field in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L52).
- [x] Fill in `model`, `serviceTier`, `reasoningLevel`, and `sandboxMode` before queuing daemon commands.
  Purpose: make daemon commands carry the execution settings the server decided to use. For thread start, `model` comes from the create-thread request, while missing `serviceTier`, `reasoningLevel`, and `sandboxMode` are filled by the server. For follow-ups and steer, missing values come from the thread's default execution options.
  Current: missing execution knobs still flow through to provider-specific defaults instead of one server-owned default in [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L23).
- [x] Make host-daemon `thread.start`, `turn.run`, and `turn.steer` execution options required after the server fills in defaults.
  Purpose: remove “maybe this command has options” ambiguity from the server/daemon boundary and ensure steer requests see the same filled-in defaults and overrides as start/run.
  Current: these commands all accept optional `options` in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L54), and server queueing only includes the field when present in [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L38).
- [x] Split the shared thread runtime command context so `turn.run` and `turn.steer` can require `providerThreadId` while `thread.start` does not.
  Purpose: stop one shared schema from making `providerThreadId` look optional where resume logic actually needs it.
  Current: `providerThreadId` is optional in the shared runtime context in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L54). The server tries to fill it from past events when queueing `turn.run` / `turn.steer` in [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L188) and [apps/server/src/services/thread-commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/services/thread-commands.ts#L236), and daemon dispatch throws if it needs to resume a runtime without one in [apps/host-daemon/src/command-handlers/thread.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/command-handlers/thread.ts#L59).
- [x] Make `dynamicTools` a required server-owned field on the host-daemon thread runtime commands.
  Purpose: let the server choose the tool list explicitly instead of having the daemon inject manager tools.
  Current: the host-daemon command schema still makes `dynamicTools` optional in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L54), and the daemon injects manager tools in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L112).
- [x] Make the server always send the full tool list for thread runtime commands: `[]` for standard threads and `[message_user]` for manager threads.
  Purpose: make manager tool selection a server-owned product decision.
  Current: manager tool injection currently happens only in the daemon in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L112).
- [x] Delete daemon-side manager tool injection and daemon-side instruction templating.
  Purpose: remove product-policy branches from the host daemon.
  Current: `resolveThreadRuntimeConfig()` in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L126) decides instructions and manager tools based on `threadType`.
- [x] Delete `threadType` from the host-daemon thread runtime command context once the daemon no longer branches on thread type.
  Purpose: remove a product-policy field from the daemon boundary after the server owns instructions and tool lists.
  Current: `threadType` is carried in [packages/host-daemon-contract/src/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/commands.ts#L52) and is currently used by daemon-side runtime-config logic.
- [x] Make the public diff API require `selection`, and make the daemon contract require it too.
  Purpose: make diff mode explicit as “combined” vs “commit” all the way from the public API down to the daemon command.
  Current: the main app already computes a selection in [apps/app/src/views/useGitDiffPanel.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/views/useGitDiffPanel.ts#L85), but the public `/environments/:id/diff` API still allows it to be omitted in [packages/server-contract/src/public-api.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/public-api.ts#L119), the CLI omits it unless `--diff-selection` is passed in [apps/cli/src/commands/thread/show.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/show.ts#L137), the server only forwards it when present in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L55), and workspace defaults missing `selection` to `{ type: "combined" }` in [packages/workspace/src/workspace.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/workspace.ts#L174).
- [x] Make the public status and diff APIs require `mergeBaseBranch`, and make the daemon commands require it too.
  Purpose: make the comparison base explicit. Callers should send the actual branch name every time.
  Current: the public `/environments/:id/status` and `/environments/:id/diff` APIs still allow `mergeBaseBranch` to be omitted in [packages/server-contract/src/public-api.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/public-api.ts#L112) and [packages/server-contract/src/public-api.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/server-contract/src/public-api.ts#L119), the app and CLI can both omit it in [apps/app/src/lib/api.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/lib/api.ts#L520) and [apps/cli/src/commands/thread/show.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/cli/src/commands/thread/show.ts#L137), the server only forwards it when present in [apps/server/src/routes/environments.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/environments.ts#L36), and workspace falls back to `readDefaultBranch()` in [packages/workspace/src/workspace.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/workspace.ts#L174).
- [x] Delete `workspace.checkpoint.remoteName` and make checkpoint always use `origin`.
  Purpose: remove an unused internal option and keep checkpoint behavior fixed. This remains an internal-only contract change; no public API should be added for it.
  Current: there is no in-tree production caller for `workspace.checkpoint`; only host-daemon tests exercise it in [apps/host-daemon/test/command/workspace-dispatch.test.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/test/command/workspace-dispatch.test.ts#L72). Workspace defaults missing `remoteName` to `"origin"` in [packages/workspace/src/workspace.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/workspace.ts#L240).
- [x] Keep `message_user` as an implementation-owned manager tool that is always included for manager threads.
  Purpose: preserve the real manager communication path as a server-owned manager tool.
  Current: `message_user` is implemented server-side in [apps/server/src/internal/tool-calls.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/tool-calls.ts#L23), but is still injected daemon-side in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L65).
- [x] Delete the manager `spawn_thread` dynamic tool and its server-side tool-call implementation.
  Purpose: remove the hallucinated manager capability instead of preserving it as a built-in tool.
  Current: `spawn_thread` is injected alongside `message_user` in [apps/host-daemon/src/thread-runtime-config.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/thread-runtime-config.ts#L65), implemented in [apps/server/src/internal/tool-calls.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/tool-calls.ts#L59), mentioned in manager templates, and covered by tests.
- [x] Always send `session.open.activeThreads`, and make the field required.
  Purpose: make daemon reconnect state explicit at session-open time.
  Current: the daemon always provides `runtimeManager.listActiveThreads()` when opening a session in [apps/host-daemon/src/server-client.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/server-client.ts#L175), but the contract still makes it optional in [packages/host-daemon-contract/src/session.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/session.ts#L24) and the server already fills in `[]` with `payload.activeThreads ?? []` in [apps/server/src/internal/session.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/session.ts#L19).

### 5. Delete Or Move Unused Provisioning Knobs

- [x] Delete `environment.provision.scriptName`.
  Purpose: override the setup script filename searched/run during provisioning.
  Current: production server provisioning calls do not set it; only tests exercise custom script names. The daemon still defaults it to `.bb-env-setup.sh` in [apps/host-daemon/src/command-handlers/environment.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/command-handlers/environment.ts#L32) and workspace provisioning does the same in [packages/workspace/src/provisioning.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/provisioning.ts#L145).
- [x] Delete `environment.provision.timeoutMs`.
  Purpose: override the setup script timeout during provisioning.
  Current: production server provisioning calls do not set it; only tests cover it. Workspace provisioning defaults to five minutes in [packages/workspace/src/provisioning.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/workspace/src/provisioning.ts#L153).

### 6. Fix Product Bugs Exposed By Optionality

- [x] Implement auto-send of the next queued draft when the current turn completes.
  Purpose: match the intended queued-follow-up model instead of the current accidental hybrid.
  Current: the app only creates drafts while the thread is `active` in [apps/app/src/views/ThreadDetailView.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/views/ThreadDetailView.tsx#L895), but `turn/completed` only transitions thread status in [apps/server/src/internal/turn-completed-events.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/turn-completed-events.ts#L7), so drafts persist and require manual send in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L215).
- [x] Delete `SendDraftRequest.mode` and delete stored draft `mode`.
  Purpose: remove redundant state about whether a queued draft should start or steer. With auto-send in place, queued drafts should follow the normal turn lifecycle automatically.
  Current: draft creation hard-codes stored `mode: "auto"` in [apps/server/src/routes/threads/actions.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/routes/threads/actions.ts#L202), the app also sends `mode: "auto"` when manually sending a queued draft in [apps/app/src/views/ThreadDetailView.tsx](/Users/michael/.codex/worktrees/93ba/bb/apps/app/src/views/ThreadDetailView.tsx#L936), tests often omit the field entirely in [apps/server/test/public-threads.test.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/test/public-threads.test.ts#L792), and only seeded tests manufacture non-`auto` stored modes.
- [ ] Fix `turn.steer.options` behavior so steer-time execution overrides are honored end-to-end and go through the same server helper that fills in defaults for other turn entry points.
  Purpose: treat active follow-up execution choices as real product behavior rather than silently ignored input.
  Current: active follow-ups can carry different execution choices, but steer ignores them downstream and does not go through the same default-filling path as other entry points.
- [x] Implement and require `workspace.status.mergeBaseBranch` instead of silently ignoring it.
  Purpose: status and archive checks should operate relative to the explicit merge-base branch the caller asked for.
  Current: callers think they can request non-default merge-base status; they cannot.
- [x] Delete the squash-merge option knobs and change workspace squash-merge behavior to always commit all source workspace changes first, using implementation-owned commit messages.
  Purpose: make squash merge one intentional operation instead of a bag of caller-controlled toggles. The desired behavior is: commit all staged and unstaged source changes onto the source branch, then squash merge that source branch into the target branch and create the final squash commit there, without exposing prep or squash message customization to callers.
  Current: `commitIfNeeded`, squash `includeUnstaged`, and squash message fields are UI-visible / CLI-visible or public-contract-visible, but the server no-ops some of them and collapses the message fields before the workspace layer. The workspace implementation currently skips any source-branch commit and only creates the final squash commit on the target branch.

### 7. Tighten Session And Polling Semantics

- [x] Make `hostDaemonHeartbeat.lastCommandCursor` required and nullable.
  Purpose: make heartbeat state explicit without using an optional field. Use a number when known and `null` when unknown.
  Current: the contract makes it optional in [packages/host-daemon-contract/src/session.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/session.ts#L88), the daemon sends `cursorState.value || undefined` in [apps/host-daemon/src/app.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/app.ts#L188), and I found no current server-side consumer of the field.
- [x] Fill in defaults for `commandsQuery.afterCursor`, `limit`, and `waitMs` at the boundary so downstream code does not invent defaults ad hoc.
  Purpose: make polling semantics explicit and predictable.
  Current: the command query schema leaves all three optional in [packages/host-daemon-contract/src/session.ts](/Users/michael/.codex/worktrees/93ba/bb/packages/host-daemon-contract/src/session.ts#L46), the daemon client always sends `afterCursor` but only sometimes sends `limit` / `waitMs` in [apps/host-daemon/src/server-client.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/host-daemon/src/server-client.ts#L200), and the server defaults them to `0`, `100`, and `0` in [apps/server/src/internal/commands.ts](/Users/michael/.codex/worktrees/93ba/bb/apps/server/src/internal/commands.ts#L23).

### 8. Update `AGENTS.md`

- [ ] Add a rule that optional contract fields are allowed only when omission has distinct semantic meaning.
- [ ] Add a rule that defaults must be stamped exactly once at the boundary.
- [ ] Add a rule that accepted-but-ignored fields are forbidden.
- [ ] Add a rule that `required + nullable` is reserved for explicit clear/unknown semantics, not defaulting.
- [ ] Add a rule that the server owns product policy and the host daemon owns host-local/provider-local execution concerns.
- [ ] Add a rule that if the server needs host-local data, the daemon should return raw data and the server should assemble the final behavior.
- [ ] Add a rule that exported function/component/route arguments must not gain optional knobs merely to support a new reuse case without first considering a wrapper, a new object type, or a separate helper.
- [ ] Add a review question for new APIs and commands: “Why is this optional?”
- [ ] Add a review question for server/daemon boundaries: “Should this decision live on the server instead?”

### 9. Validation

- [ ] `pnpm exec turbo run typecheck --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/cli --filter=@bb/workspace --filter=@bb/agent-runtime --filter=@bb/db --filter=@bb/domain`
- [ ] `pnpm exec turbo run test --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/workspace --filter=@bb/db`
- [ ] Add or update behavior tests for every field that changes from optional to required or from “accepted” to deleted.
- [ ] Verify that tests assert real behavior and outcomes, not just queued payload shapes.
- [ ] Audit the daemon for server-owned product policy that still lives there. Focus on defaults, instruction assembly, tool selection, and other non-host-local branching.

## Out Of Scope Follow-Up

After the boundary cleanup is complete, run the same audit on exported functions, component props, and internal helper signatures. The same anti-pattern exists there: a reusable function starts strict, later callers add optional knobs, and eventually no single call site makes behavior obvious.
