# Phase 2b Findings: apps/app Cut-Over to New Contracts

## Completed Mechanical Renames

All import paths already pointed at new packages (`@bb/domain`, `@bb/server-contract`, `@bb/core-ui`). No `@bb/core` or `@bb/env-daemon-contract` imports existed.

### Type renames applied

| Old | New | Package |
|---|---|---|
| `SpawnThreadRequest` | `CreateThreadRequest` | `@bb/server-contract` |
| `TellThreadRequest` | `SendMessageRequest` | `@bb/server-contract` |
| `EnqueueThreadMessageRequest` | `CreateDraftRequest` | `@bb/server-contract` |
| `SendQueuedThreadMessageRequest` | `SendDraftRequest` | `@bb/server-contract` |
| `SendQueuedThreadMessageResponse` | `SendDraftResponse` | `@bb/server-contract` |
| `CommitOperationOptions` | `CommitOptions` | `@bb/server-contract` |
| `SquashMergeOperationOptions` | `SquashMergeOptions` | `@bb/server-contract` |
| `EnvironmentOperationResponse` | `EnvironmentActionResponse` | `@bb/server-contract` |
| `EnvironmentOperationApiError` | `EnvironmentActionApiError` | `@bb/server-contract` |
| `EnvironmentOperationFailureDetails` | `EnvironmentActionFailureDetails` | `@bb/server-contract` |
| `PrimaryCheckoutStatus` | `EnvironmentPrimaryStatusResponse` | `@bb/server-contract` |
| `ThreadToolGroupMessagesResponse` | `TimelineToolDetailsResponse` | `@bb/server-contract` |
| `ThreadOperationRequest` | `EnvironmentActionRequest` | `@bb/server-contract` |

### Field renames applied

| Context | Old | New |
|---|---|---|
| `EnvironmentActionRequest` | `operation` | `action` |
| `EnvironmentActionRequest` | `"promote_primary"` | `"promote"` |
| `EnvironmentActionRequest` | `"demote_primary"` | `"demote"` |

### Route path renames applied in `api.ts`

| Old route path | New route path |
|---|---|
| `.manager.$post` | `.managers.$post` |
| `.tell.$post` | `.send.$post` |
| `.queue.$post` | `.drafts.$post` |
| `.queue[":queuedMessageId"]` | `.drafts[":draftId"]` |
| `["workspace-status"]` | `["work-status"]` |
| `["merge-base-branches"]` | `.diff.branches` |
| `["tool-group-messages"]` | `.timeline["tool-details"]` |
| `["git-diff"]` | `.diff` |
| `environments[":id"].operations` | `environments[":id"].actions` |

### Function/hook renames applied

| Old | New |
|---|---|
| `spawnThread` / `useSpawnThread` | `createThread` / `useCreateThread` |
| `tellThread` / `useTellThread` | `sendThreadMessage` / `useSendThreadMessage` |
| `enqueueThreadMessage` / `useEnqueueThreadMessage` | `createThreadDraft` / `useCreateThreadDraft` |
| `sendQueuedThreadMessage` / `useSendQueuedThreadMessage` | `sendThreadDraft` / `useSendThreadDraft` |
| `deleteQueuedThreadMessage` / `useDeleteQueuedThreadMessage` | `deleteThreadDraft` / `useDeleteThreadDraft` |
| `getThreadToolGroupMessages` / `useThreadToolGroupMessages` | `getThreadTimelineToolDetails` / `useThreadTimelineToolDetails` |
| `getThreadMergeBaseBranches` | `getThreadDiffBranches` |
| `getThreadGitDiff` | `getThreadDiff` |
| `requestEnvironmentOperation` / `useRequestEnvironmentOperation` | `requestEnvironmentAction` / `useRequestEnvironmentAction` |

### `ThreadChangeKind` import moved from `@bb/server-contract` to `@bb/domain`

---

## Types Missing from `@bb/server-contract`

These types are imported by the app but do not exist in the new `@bb/server-contract`. The app still compiles references to them; they need to be either added to the contract or the app features that use them need to be reworked/removed.

| Type | Used by | Notes |
|---|---|---|
| `OpenPathTarget` | `open-path-preferences.ts`, `OpenPathButton.tsx`, `api.ts` | Route `/system/open-path` was removed from contract |
| `OpenThreadPathRequest` | `api.ts` | Route `/threads/:id/open-path` was removed from contract |
| `ProjectFileSuggestion` | `api.ts`, `useApi.ts` | Route `/projects/:id/files` not in contract |
| `UploadedPromptAttachment` | `api.ts`, `useApi.ts`, `prompt-draft.ts` | Route `/projects/:id/attachments` not in contract |
| `PromptMentionSuggestion` | `PromptMentionMenu.tsx`, `PromptBox.tsx`, `usePromptFileMentions.ts`, test | Not in contract |
| `SystemEnvironmentInfo` | `thread-archive.ts`, `environment-icon.ts`, `usePromptModelReasoning.ts` | Route `/system/environments` removed; replaced by `/hosts` + `/environments` |
| `SystemStatus` | `api.ts`, `useApi.ts` | Route `/system/status` not in contract |
| `SystemRestartPolicy` | `api.ts`, `useApi.ts` | Route `/system/restart-policy` removed |
| `SystemRestartRequest` | `api.ts`, `useApi.ts` | Route `/system/restart` not in contract |
| `SystemRestartAcceptedResponse` | `api.ts`, `useApi.ts` | Route `/system/restart` not in contract |
| `ServerRuntimeMode` | `runtime-mode.ts` | Not in contract |
| `SystemShutdownBlockingThread` | `api.ts` | Exists in contract (ok) |
| `SystemShutdownBlockedResponse` | `api.ts` | Exists in contract (ok) |

## Types Missing from `@bb/domain`

| Type | Used by | Notes |
|---|---|---|
| `EnvironmentCapabilities` | `thread-primary-checkout.ts`, test | Not exported from `@bb/domain` |
| `ThreadContextWindowUsage` | `thread-context-window-usage.ts` | Not exported from `@bb/domain` (the timeline response has `contextWindowUsage` inline) |

## Domain Shape Mismatches (Thread, Project, Environment)

The `Thread`, `Project`, and `Environment` types in `@bb/domain` have changed shape. The app references fields that no longer exist.

### `Thread` type

| Missing field | Used by | Notes |
|---|---|---|
| `attachedEnvironment` | `ThreadDetailView.tsx`, test | Old: embedded environment object. New: only `environmentId` exists |
| `primaryCheckout` | `ThreadDetailView.tsx`, test | Old: embedded primary checkout state. New: fetch via `/environments/:id/primary-status` |
| `builtInActions` | `ThreadDetailView.tsx`, test | Not in new Thread type |
| `workStatus` | `ThreadDetailView.tsx` | Old: embedded work status. New: fetch via `/threads/:id/work-status` |
| `titleFallback` | `thread-title.ts`, views | Not in new Thread type |

### `Project` type

| Missing field | Used by | Notes |
|---|---|---|
| `rootPath` | `ProjectMainView.tsx` | Not in new Project type; path lives on Source/Environment |
| `projectInstructions` | `ProjectSettingsView.tsx` | Not in new Project type |

### `Environment` type

| Missing field | Used by | Notes |
|---|---|---|
| `properties` (with `workspaceKind`, `location`) | `thread-archive.ts` | New Environment type has different shape |

### `ThreadStatus` enum changes

| Value | Status | Notes |
|---|---|---|
| `provisioned` | Removed | App uses in switch statements in `thread-activity.ts`, `useWebSocket.ts` |
| `provisioning_failed` | Removed | App uses in switch statements in `thread-activity.ts`, `useWebSocket.ts` |

### `ThreadQueuedMessage` field renames

| Old field | New field | Notes |
|---|---|---|
| `input` | `content` | `ThreadFollowUpComposer.tsx`, `ThreadDetailView.tsx` reference `.input` |

## API Route Gaps

Routes the app uses that are not in the new `PublicApiSchema`:

| Route | App function | Notes |
|---|---|---|
| `/system/pick-folder` | `pickProjectFolder()` | Removed (client-side now) |
| `/system/open-path` | `openPathInEditor()` | Removed (client-side now) |
| `/threads/:id/open-path` | `openThreadPathInEditor()` | Removed (client-side now) |
| `/threads/:id/default-execution-options` | `getThreadDefaultExecutionOptions()` | Not in contract |
| `/threads/:id/manager-workspace/files` | `listThreadManagerWorkspaceFiles()` | Not in contract |
| `/threads/:id/manager-workspace/file` | `getThreadManagerWorkspaceFile()` | Not in contract |
| `/threads/:id/output` | `getThreadOutput()` | Added to contract — app callsite needs updating |
| `/system/status` | `getSystemStatus()` | Not in contract |
| `/system/provider` (singular) | `getSystemProvider()` | Removed; use `/system/providers` |
| `/system/environments` | `listSystemEnvironments()` | Removed; use `/environments` |
| `/system/restart-policy` | `getSystemRestartPolicy()` | Removed |
| `/system/restart` | `restartServer()` | Not in contract |
| `/projects/:id/files` | `searchProjectFiles()` | Not in contract |
| `/projects/:id/attachments` | `uploadPromptAttachment()` | Not in contract |

### Query parameter mismatches

| Route | Param | Notes |
|---|---|---|
| `GET /threads` | `includeWorkStatus` | Not in new contract query params |
| `GET /threads` | `includeArchived` | Present in old but not in new contract |
| `GET /threads/:id/timeline` | `includeToolGroupMessages` | Removed; tool details are a separate endpoint now |

### Request body mismatches

| Route | Field | Notes |
|---|---|---|
| `POST /threads/:id/send` | `demotePrimaryIfNeeded` | Not in `SendMessageRequest` schema |

### Send message mode mismatch

Resolved: `"steer-if-active"` replaced with `"auto"` (same semantics — start if idle, steer if active).

## `EnvironmentActionFailureDetails` shape mismatch

The old `EnvironmentOperationFailureDetails` had a `request` subfield containing the original operation request (with `options`). The new `EnvironmentActionFailureDetails` does not have this field. The app's follow-up instruction builders (`buildCommitFailureFollowUpInstruction`, etc.) depend on `details.request.options` to reconstruct retry instructions. Either:

1. Add `request` field to the failure details schema, or
2. Rework the follow-up builders to accept options separately
