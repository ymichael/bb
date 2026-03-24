# Phase 2b Findings: apps/app Cut-Over to New Contracts

## Resolved

- All type renames applied (SpawnThread→CreateThread, Tell→Send, etc.)
- All route renames applied (tell→send, queue→drafts, operations→actions, etc.)
- All function/hook renames applied
- `ThreadChangeKind` import moved from `@bb/server-contract` to `@bb/domain`
- `steer-if-active` → `auto` send mode
- `projectInstructions` / `ProjectSettingsView` deleted
- SystemRestart*, SystemStatus, ServerRuntimeMode, StatusFooter deleted
- `demotePrimaryIfNeeded` removed from send message
- `includeArchived` → `archived` filter
- `/system/provider` (singular) → removed, use `/system/providers`
- Dead code swept via knip (8 files deleted, 19 files cleaned)
- `ThreadQueuedMessage.input` → `.content`
- Project response now includes sources (no separate route)
- Workspace status moved to `GET /environments/:id/status`
- `isPromoted` dropped from API
- `provisioned` / `provisioning_failed` removed from switch statements
- `titleFallback` added back to domain type
- `PromptMentionSuggestion` moved to app-local type (assembled client-side from file search + thread list)
- `UploadedPromptAttachment` and `ProjectFileSuggestion` re-added to server contract with routes
- `SystemEnvironmentInfo` deleted — environment-icon deleted, useSystemEnvironments removed, thread-archive simplified to check `environment.managed` directly
- `ThreadContextWindowUsage` exported from server contract
- `usePromptFileMentions` renamed to `usePromptMentions` (returns file + thread mentions)
- `ThreadStatusShape` / thread-activity test fixtures fixed (null not undefined, missing fields added)
- Dead routes in api.ts: `manager-workspace` → `workspace`, `getThreadWorkStatus` → `getEnvironmentWorkStatus`, deleted `getProjectWorkspaceStatus`/`pickProjectFolder`/`openThreadPathInEditor`
- `includeWorkStatus` removed from `listThreads` filter
- `api-client.ts` renamed to `api-server.ts`
- jotai + `@bb/host-daemon-contract` added as app dependencies
- `systemConfigAtom`, `localHostIdAtom`, `hostDaemonPortAtom` created
- `api-host-daemon.ts` created with `fetchHostId`, `openPath`, `pickFolder`
- `useHostDaemon` hook created: `localHostId`, `hasDaemon`, `isLocalHost`, `openPath`, `pickFolder`
- `/system/config` endpoint added to server contract (returns `hostDaemonPort`)
- `/pick-folder` route added to host daemon local API contract
- `open-path-preferences.ts` deleted (editor prefs will be per-host later)
- `projectPathInput.ts` simplified: removed `requestProjectRootPath` fallback
- `useEnvironment` and `useEnvironmentWorkStatus` hooks added
- `getEnvironment` API function added

## In progress (agent running)

- `attachedEnvironment` on Thread → fetch via `useEnvironment(thread.environmentId)`
- `workStatus` on Thread → fetch via `useEnvironmentWorkStatus(thread.environmentId)`
- `primaryCheckout` on Thread → code deleted (to be re-derived from environment later)
- `builtInActions` on Thread → code deleted (derive from environment properties later)
- `queuedMessages` on Thread → remove optimistic update, use query invalidation
- Dead imports: `openThreadPathInEditor`, `getPathCommandForTarget` removed from views
- Test fixtures updated to remove dead fields

## Remaining after agent completes

### Needs rootPath → sources rework (~12 errors)

| Issue | Files | What needs to happen |
|---|---|---|
| `project.rootPath` references | ProjectMainView, ThreadDetailView, ProjectList | Use `project.sources.find(s => s.hostId === localHostId)?.path` |
| `useQuickCreateProject` passes `rootPath` | useQuickCreateProject.ts | Pass `{ hostId, sourcePath }` from source lookup via `useHostDaemon` |
| "Change/repair project path" in ProjectList | ProjectList.tsx | Update/add project source, not `rootPath` on project |
| `rootPathExists` check | ProjectList.tsx | Derive from source availability or daemon local file check |
| Test fixtures with `rootPath` | ThreadDetailView.test, ProjectList.test, AppLayout.test | Update to use sources array shape |
