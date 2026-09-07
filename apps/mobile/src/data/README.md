# Data layer (`src/data`)

TanStack Query hooks and pure helpers the screens read and mutate through.
They mirror the web app's `apps/app/src/hooks/{queries,mutations}` semantics
(stale times, optimistic updates, invalidation) on top of the active
profile's SDK (`useProfileClient().sdk`) and the mobile realtime manager.

Conventions:

- One folder per area (`sidebar/`, `threads/`, `thread-detail/`, `projects/`,
  `sections/`, `hosts/`, `system/`, `compose/`, `environments/`,
  `interactions/`, `thread-runtime/`, `terminals/`, `plugins/`, `skills/`),
  each with an `index.ts`
  barrel. Import `@/data/<area>`.
- Hooks (`use-*.ts`, `*-queries.ts`, `*-mutations.ts`) may import React,
  TanStack, and `@/app-shell/ProfilesProvider`. Pure modules
  (`*-cache.ts`, `*-model.ts`, `*-preferences.ts`, `compose/*`,
  `read-tracking.ts`) never import react-native and are vitest-tested (node
  env); RN adapters (MMKV storage) live in their own small files.
- Query keys come from `@/lib/query/query-keys` and every key is mapped in
  `@/lib/query/realtime-invalidation.ts`. Add both when adding a query.
- Realtime subscriptions are held through `shared/use-realtime-subscription`
  (refcounted per target; the last unmount releases the server subscription).
- `thread-detail/` mirrors the web thread-detail queries: the bootstrap
  (`GET /threads/:id?include=environment,host`, seeds thread/environment/host
  caches, prefetches the timeline), the timeline window with `afterSequence`
  deltas (`timeline-fetch.ts`, pure), the loaded-window controller over the
  `@bb/client-core` merge/paging helpers, pending interactions, queued
  messages, the thread's default execution options (what the follow-up
  composer seeds its pills with; invalidated after an accepted send, a
  history rewrite, and realtime `environment-changed`), lazy turn details,
  and the child-thread roll-up. The realtime
  bridge invalidates the timeline window through the paced, non-cancelling
  path in `@/lib/query/timeline-refetch-pacing.ts` on every
  `events-appended`.
- `interactions/` owns acting on pending interactions: `useResolvePendingInteraction`
  (approvals + user answers), `useRespondPluginInteraction` /
  `useCancelPluginInteraction` (plugin forms), the returned interaction is
  written into the pending list before the realtime refetch; pure, tested
  helpers for the question form state (shared by the native `user_question`
  and the `ask-user-question` plugin payload), approval presentation, plugin
  payload parsing (`@bb/plugin-interaction-contracts`), and the child-thread
  attention roll-up (`useChildThreadPendingInteractions`).
- `thread-runtime/` mirrors the web thread-runtime cache owner: send (optimistic
  user row with `OPTIMISTIC_TIMELINE_ROW_ID_PREFIX`, or an optimistic queued
  message when the thread is active), edit message, stop (thread + lists flip
  to `stopping`; `appendPendingStopRow` adds the client-only "Stop requested"
  row at projection time), cancel plan / clear goal, and the queued-message
  create / update / delete / send-now / reorder / group-boundary transactions
  with rollback; `queued-message-order.ts` holds the move-up/down and group
  toggle request builders the native list uses instead of drag.
- `environments/` mirrors the web environment queries/mutations the thread
  detail needs: `useEnvironment`, `useEnvironmentWorkspace` (status query
  keyed by the requested merge base + the optimistic merge-base pick persisted
  through `PATCH /environments/:id`), `useEnvironmentPullRequest` (polls open
  PRs with pending checks), `useEnvironmentMergeBaseBranches`,
  `useEnvironmentAction` (commit / PR ready / draft / merge;
  owns the loading → success / 409 "blocked" warning / error toasts),
  `useUpdateEnvironment`. Pure, tested:
  `workspace-status.ts` (change tally + summary, changed-files section, git
  status display), `pull-request-display.ts` (state / checks / attention
  tones, banner action, freshness policy), `merge-base.ts`,
  `environment-action-model.ts` (header git actions, failure description).
  Every hook holds the `environment-detail` realtime subscription so the
  daemon watches the workspace; `work-status-changed` / `git-refs-changed`
  invalidate the status / branches keys (the PR is remote state: it refetches
  on a `turn/completed` of a thread in the environment and on its own
  pending-check poll, never on a file edit).
- `diff/` backs the workspace panel's Diff tab (mirror of the web
  `useEnvironmentDiffFiles` / `use-environment-diff-patches` /
  `gitDiffPanelHelpers` / `diffFilesStore`): `useEnvironmentDiffFiles`
  (`GET /environments/:id/diff/files?target=…` — the per-file table of
  contents with `loadMode` tiers, shortstat, `mergeBaseRef`, and the inline
  `initialPatches`; keeps the previous target's slice as placeholder),
  `useEnvironmentDiffPatches` (the list reports its visible + overscan
  `auto` paths; coalesced 80 ms, fetched viewport-first in
  `POST /diff/patch` pages of ≤50, each patch cached observer-less under
  `[environmentDiffPatch, env, targetType, targetKey, path]`; per-path
  loading / error state, `loadPath` for `on_demand`, `retry`; responses for
  a switched target or an evicted cache are dropped),
  `useDiffTarget` (the picker: all / committed / uncommitted / a
  commit over `useEnvironmentWorkspace`'s merge base; a stale pick derives
  back to the default), `useDiffCardCollapsed` / `useDiffCollapseAll` over
  the in-memory `diffCardStateStore` keyed by diff identity + path. Pure,
  tested: `diff-target.ts` (target ↔ picker value, the `diff/files` query
  params, options, reset, identity), `diff-patch-state.ts` (in-flight
  bookkeeping, viewport → pages, tiering), `diff-card-state.ts`,
  `add-to-chat.ts` (a file's unified patch text for the composer quote).
  The patch cache itself lives in `@/lib/query/diff-patch-cache.ts`: the
  realtime bridge evicts it (remove + generation bump) on every
  environment change before invalidating the TOC, and
  `invalidateEnvironmentActionQueries` does the same after a commit;
  `retainDiffPatchQueries` drops an environment's patches two
  minutes after its last reader unmounts.
- `terminals/` backs the workspace panel's Terminal tab and the full-screen
  terminal route (mirror of the web `thread-terminal-queries` +
  `terminal-cache-owner`): `useTerminals(scope)`
  (`GET /terminals?threadId|environmentId|hostId`,
  realtime-owned), `useTerminalSession(id)` (seeded from any cached list),
  `useCreateTerminal` / `useRestartTerminal` / `useCloseTerminal` /
  `useRenameTerminal`, and `useFetchTerminalOutput`
  (`GET /terminals/:id/output?sinceSeq=`, the replay-gap fallback the attach
  stream uses after a resume). `terminal-cache.ts` writes the session the
  socket streams (`attached` / `session-updated` / `exited`) into the list +
  record caches (an exited session leaves the list); `terminal-session-model.ts`
  is pure: row / status labels, ordering, the not-running notice, and
  `normalizeTerminalTitle` (the shell's OSC title, path-like prompts ignored).
  Realtime `terminals-changed` (a thread change) invalidates both key prefixes.
- `files/` backs the Files tab and the file previews (mirror of the web's
  `useThreadStorageBrowser` / `useFileSearchSuggestions` /
  `useEnvironmentFilePreview` / `useThreadStorageFilePreview` /
  `useThreadHostFilePreview` / `useProjectFilePreview`):
  `useThreadStorageFiles` (`GET /threads/:id/thread-storage/files`, the flat
  list + `storageRootPath`; `thread-storage-changed` refreshes it),
  `useFileSearch` (debounced; environment or project paths + thread-storage
  paths, files only, one ranked section per source), `useWorkspaceFilePreview`
  (`sdk.environments.diffFile` for the working tree / HEAD / merge base, key
  `[environmentFilePreview, env, path, source]`, invalidated on
  `work-status-changed`), `useThreadStorageFilePreview` /
  `useThreadHostFilePreview` / `useProjectFilePreview` (the raw content routes
  through the profile fetch → `buildFilePreview` + `sizeBytes`; 413
  `file_too_large` surfaces as a `BbHttpError` with that code), all on the
  heavy-payload gc policy. Pure, tested: `file-content-urls.ts` (absolute
  URLs of the content / raw routes), `file-preview-fetch.ts` (byte
  classification, base64 ↔ `data:` URLs for workspace images, error
  mapping), `file-preview-model.ts` (`resolveFilePreviewContent` — the body
  kind per preview / error / HTML raw URL, code truncation budget, CSV
  parsing, `buildFileLineSelectionText` for "Add to chat", sizes / names),
  `storage-tree.ts` (directory listing + breadcrumbs + substring filter over
  the flat storage list), `file-search.ts` (sections, match-highlight
  segments), `local-file-links.ts` (absolute path → workspace / storage /
  host resolution, relative-link candidates, sibling resolution),
  `recent-files.ts` (per-thread recents under the web's
  `bb.thread.recentItems-<threadId>-1` key; MMKV adapter in
  `recent-files-storage.ts`, `useThreadRecentFiles`), and
  `thread-composer-host.ts` (the per-thread "Add to chat" registry the
  thread screen fills and previews read).
- `compose/compose-seed-params.ts`: the `/compose` route params that seed a
  thread from another one (fork from a message, handoff, reuse worktree) with
  builders for the actions and readers for the compose controller.
- `composer/` backs the shared composer (`@/composer`): the per-scope draft
  store (`bb.promptbox.contents-*`, web `PromptDraftState` format, MMKV) +
  `useComposerDraft`, attachment upload / voice transcription request
  builders and mutations over the XHR multipart poster, and the typeahead
  queries (plugin contributions + mention search via raw fetch, environment /
  thread-storage paths, project commands).
- `notifications/` is the push layer's policy, pure and vitest-tested; the RN
  glue (expo-notifications, MMKV, navigation) lives in `src/notifications`.
  `push-registration.ts`: `decidePushSync` (toggle × EAS project id × OS
  permission × existing record → skip / unregister / fetch-token),
  `shouldReregister` (token / platform / server change, daily refresh),
  `syncPushRegistration` (never throws; removes the stale row before a
  re-register), `unregisterPushRegistration` (by profile id: the record keeps
  the server URL, so a removed profile can still be cleaned up),
  `enablePushForProfile` (asks the OS once), `describePushStatus`.
  `push-registration-controller.ts` coalesces concurrent syncs per profile
  and reconciles removed profiles / token rolls. `push-store.ts` is the
  injected-storage store (MMKV `bb.preferences` in the app, a Map in tests).
  `push-subscriptions-api.ts` calls the `push-notifications` plugin RPC
  through `sdk.plugins.callRpc`. It keys clients by server URL, not by a
  profile client that the app can dispose. Its list reads local validated
  records with `tokenSuffix`.
  `push-notification-target.ts` parses a payload's `data` and picks the
  profile (matching server hint → probe active first).
  `app-badge.ts` counts unread finished root threads + pending interactions
  from the sidebar bootstrap.
- `hosts/` (Phase 7 additions) backs Settings → Machines and → Updates on
  top of the list/directory queries: `useHostProviderCliStatus` /
  `useHostsProviderCliStatus` (`GET /hosts/:id/provider-clis/status`,
  session-static; the Updates check and a finished install invalidate it),
  `useRemoveHost`, `useRetryHostUpdate`, `useUpdateHostPermissionCeiling`
  (`PATCH /hosts/:id/permission-ceiling` through the profile fetch in
  `permission-ceiling.ts` — the route is owner-session-only and deliberately
  absent from the SDK), `useAddMachineSession`
  (`begin()` from the press handler snapshots the known hosts and mints the
  join code + the connect machine code through the connect plugin RPC, a 1 s
  expiry clock, the new machine detected live from the `host-list`
  subscription), and the provider CLI install runner
  (`use-provider-cli-install.ts`: one module-level store bound to each
  profile's SDK so an install outlives the screen; success / failure toasts
  with "View log"; status + execution-option invalidation on finish). Pure,
  tested: `select-primary-host.ts`,
  `host-update-status.ts` (stranded-daemon rules against the server's
  protocol version from `useServerProtocolVersion` / `GET /install/version`,
  never this build's `HOST_DAEMON_PROTOCOL_VERSION`: the phone ships
  independently of the server), `host-display.ts` (presence / meta lines,
  `formatRelativeAge`), `add-machine.ts` (`pairingCommand`, `isLocalOnlyUrl`,
  `createConnectMachineCode` error mapping, `resolveAddMachinePresentation`),
  `provider-cli-install.ts` (issues, row state, the event accumulator + log
  truncation), `provider-cli-install-store.ts` (queue of one, records,
  sequenced "View log" requests).
- `settings/` backs the settings screens: `useUpdateGeneralSettings` /
  `useUpdateExperiments` / `useUpdateAppearance` (`PUT /settings/*` with an
  optimistic write into the cached `/system/config` and rollback),
  `useThemeCatalog` (`GET /settings/themes`), `useSystemUsageLimits`
  (`GET /system/usage-limits?hostId=`), `useCliSkillsStatus` /
  `useInstallCliSkills`, and the device-local preferences store
  (`local-preferences.ts`, MMKV `bb.preferences` under the web's keys —
  `bb.rewriteLocalhostLinks`, read by the markdown renderers through
  `useRewriteLocalhostLinksPreference`). Pure, tested: `usage-limits-model.ts`,
  `cli-skills-model.ts`, `appearance-model.ts` (built-in palettes render
  natively, custom / plugin palettes are selectable but shown as the default
  palette on mobile; favicon tints).
- `updates/` mirrors the web `useUpdateInventory` without the desktop branch:
  `buildUpdateInventory` (pure, tested) over the version query + every
  connected machine's provider CLI status, `summarizeMachineUpdates`,
  `bbAppRowState`, `useUpdateInventory`, and `useCheckForUpdates`
  (`GET /system/version?force=true` written into the cache, then the
  per-machine status + CLI skills invalidated).
- `plugins/` backs plugin management (mirror of the web's
  `plugin-settings-queries` / `plugin-catalog-queries` / `plugin-cache-owner`):
  `usePluginList` (`GET /plugins`, `system` subscription, `plugins-changed`
  invalidates), `usePlugin`, `usePluginSettings` (`GET /plugins/:id/settings`;
  only once the factory ran), `usePluginUpdates` (`GET /plugins/updates`),
  `usePluginLogs` (`GET /plugins/:id/logs?tail=` through the profile fetch —
  not in the SDK), `usePluginCatalogSearch` (`GET /plugin-catalog/search`,
  placeholder across queries), `usePluginCatalogInstallPlan` (never cached),
  `usePluginMarketplaces`, `useServerSvgAsset` (a branding SVG read as text,
  session-static). Mutations write the returned plugin into the list cache
  and then invalidate the roster (list, updates, settings, catalog `installed`
  flags, contributions, the skills library): `useSetPluginEnabled`,
  `useUpdatePluginSettings`, `useCheckPluginUpdates`, `useApplyPluginUpdate`,
  `useRemovePlugin`, `useReloadPlugins`, `useInstallPlugin` (direct source or
  catalog entry + `confirmedSource`), `useAddMarketplace`,
  `useRefreshMarketplaces`, `useRemoveMarketplace`. Pure, tested:
  `plugin-model.ts` (row signal precedence, runtime health presentation +
  recovery, settings availability, the write-only-secret change set, update
  summaries, catalog grouping by publisher, source-input normalization),
  `plugin-logs.ts`.
- `skills/` backs the skills library and the skills.sh registry (mirror of
  the web's `skills-queries` + `lib/skills-registry`): `useProjectSkills`
  (`GET /projects/:id/skills`, `refetchOnMount: "always"` — SKILL.md files
  change out of band), `useProjectSkill`, `useSkillFiles`, `useSkillContent`,
  `useRegistrySkills` (one page; the screen accumulates), `useRegistrySkillEntry`,
  `useRegistrySkillDetail`, `useInstallRegistrySkill`, `useDeleteSkill`. Pure,
  tested: `skill-model.ts` (scope labels / editability, grouping, registry
  page accumulation with ranking resets, installed-entry resolution, file
  pick).
- Mutations set `meta.errorMessage` for the profile QueryClient's global error
  toast; ones whose callers render errors inline set `showErrorToast: false`.
- `scripts/data-smoke.mts` exercises the layer end to end against the mobile
  e2e backend (`pnpm --filter @bb/integration-tests e2e:mobile-backend`).
