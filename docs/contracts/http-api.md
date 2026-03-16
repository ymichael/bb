# HTTP + WS API Contracts

Base path: `/api/v1`

## Error Envelope

All route errors use:

- `code`: domain code or `internal_error`
- `message`: human-readable summary
- `retryable?`: retry hint
- `details?`: optional structured details
- `error`: backward-compatible alias for `message`

Status mapping is defined in `apps/server/src/routes/error-response.ts`.

## Project Endpoints

- `POST /projects`
  - body: `createProjectSchema`
  - response: `Project` (201)
- `PATCH /projects/:id`
  - body: `updateProjectSchema`
  - response: `Project`
- `DELETE /projects/:id`
  - response: `{ ok: true }`
- `GET /projects`
  - response: `Project[]`
- `GET /projects/:id/files?query=&limit=`
  - response: `ProjectFileSuggestion[]`
- `GET /projects/:id/workspace-status`
  - response: `ThreadWorkStatus | null`
- `POST /projects/:id/attachments`
  - body: multipart form with `file`
  - response: `UploadedPromptAttachment` (201)
- `GET /projects/:id/attachments/content?path=`
  - response: attachment bytes

## Thread Endpoints

- `POST /threads`
  - body: `spawnThreadSchema`
  - response: `Thread` (201)
- `POST /threads/:id/open-path`
  - body: `OpenThreadPathRequest`
  - response: `{ ok: true }`
- `GET /threads?projectId=&parentThreadId=&includeArchived=&includeWorkStatus=`
  - response: `Thread[]`
- `GET /threads/:id`
  - response: `Thread`
- `GET /threads/:id/default-execution-options`
  - response: `ThreadExecutionOptions | null`
- `PATCH /threads/:id`
  - body: `updateThreadSchema`
  - response: `Thread`
- `POST /threads/:id/tell`
  - body: `tellThreadSchema`
  - response: `{ ok: true }`
- `POST /threads/:id/queue`
  - body: `enqueueThreadMessageSchema`
  - response: `ThreadQueuedMessage` (201)
- `POST /threads/:id/queue/:queuedMessageId/send`
  - body: `sendQueuedThreadMessageSchema`
  - response: `SendQueuedThreadMessageResponse`
- `DELETE /threads/:id/queue/:queuedMessageId`
  - response: `{ ok: true }`
- `POST /threads/:id/operations`
  - body: `threadOperationSchema`
  - response: `ThreadOperationResponse` (202)
- `POST /threads/:id/stop`
  - response: `{ ok: true }`
- `POST /threads/:id/archive`
  - response: `{ ok: true }`
- `POST /threads/:id/unarchive`
  - response: `{ ok: true }`
- `POST /threads/:id/read`
  - response: `Thread`
- `POST /threads/:id/unread`
  - response: `Thread`
- `GET /threads/:id/work-status?mergeBaseBranch=`
  - response: `ThreadWorkStatus | null`
- `GET /threads/:id/merge-base-branches`
  - response: `string[]`
- `GET /threads/:id/primary-status`
  - response: `PrimaryCheckoutStatus`
- `GET /threads/:id/timeline?limit=&includeToolGroupMessages=`
  - response: `ThreadTimelineResponse`
- `GET /threads/:id/tool-group-messages?turnId=&sourceSeqStart=&sourceSeqEnd=`
  - response: `ThreadToolGroupMessagesResponse`
- `GET /threads/:id/git-diff?selection=&commitSha=&mergeBaseBranch=`
  - response: `ThreadGitDiffResponse`
- `POST /threads/:id/promote`
  - response: `PromoteThreadResponse`
- `POST /threads/:id/demote-primary`
  - response: `DemotePrimaryResponse`
- `GET /threads/:id/events?afterSeq=`
  - response: `ThreadEvent[]`
- `GET /threads/:id/output`
  - response: `{ output: string | null }`

## System Endpoints

- `GET /system/status`
  - response: `SystemStatus`
- `POST /system/pick-folder`
  - response: `{ path: string | null }`
- `POST /system/open-path`
  - body: `OpenPathRequest`
  - response: `{ ok: true }`
- `POST /system/voice-transcription`
  - body: multipart form with `file`, optional `prompt`
  - response: transcription payload
- `GET /system/models`
  - response: `AvailableModel[]`
- `GET /system/provider`
  - response: `SystemProviderInfo`
- `GET /system/providers`
  - response: `SystemProviderInfo[]`
- `GET /system/environments`
  - response: `SystemEnvironmentInfo[]`
- `GET /system/restart-policy`
  - response: `SystemRestartPolicy`
- `POST /system/shutdown`
  - body: `SystemShutdownRequest`
  - response: `SystemShutdownAcceptedResponse | SystemShutdownBlockedResponse`
- `POST /system/restart`
  - body: `SystemRestartRequest`
  - response: `SystemRestartAcceptedResponse | SystemShutdownBlockedResponse`

## WebSocket Contract

Endpoint: `/ws`

Client messages:

- `subscribe` with `{ entity: "thread", id?: string }`
- `unsubscribe` with `{ entity: "thread", id?: string }`

Server messages:

- `changed` with `{ entity: "thread", id?: string }`
