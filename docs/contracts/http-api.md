# HTTP + WS API Contracts

Base path: `/api/v1`

## Error Envelope

All route errors use:

- `code`: domain code or `internal_error`
- `message`: human-readable summary
- `retryable?`: retry hint
- `details?`: optional structured details
- `error`: backward-compatible alias for `message`

Status mapping is defined in `apps/daemon/src/routes/error-response.ts`.

## Project Endpoints

- `POST /projects`
  - body: `createProjectSchema`
  - response: `Project` (201)
- `PATCH /projects/:id`
  - body: `updateProjectSchema`
  - response: `Project`
- `GET /projects`
  - response: `Project[]`
- `GET /projects/:id/files?query=&limit=`
  - response: `ProjectFileSuggestion[]`

## Thread Endpoints

- `POST /threads`
  - body: `spawnThreadSchema`
  - response: `Thread` (201)
- `GET /threads?projectId=&parentThreadId=&includeArchived=`
  - response: `Thread[]`
- `GET /threads/:id`
  - response: `Thread`
- `GET /threads/:id/default-execution-options`
  - response: `ThreadExecutionOptions | null`
- `POST /threads/:id/tell`
  - body: `tellThreadSchema`
  - response: `{ ok: true }`
- `POST /threads/:id/operations`
  - body: `threadOperationSchema`
  - response: `ThreadOperationResponse` (202)
- `POST /threads/:id/stop`
  - response: `{ ok: true }`
- `POST /threads/:id/archive`
  - response: `{ ok: true }`
- `GET /threads/:id/events?afterSeq=`
  - response: `ThreadEvent[]`
- `GET /threads/:id/output`
  - response: `{ output: string | null }`

## System Endpoints

- `GET /system/status`
  - response: `SystemStatus`
- `POST /system/pick-folder`
  - response: `{ path: string | null }`
- `GET /system/models`
  - response: `AvailableModel[]`
- `GET /system/provider`
  - response: `SystemProviderInfo`
- `GET /system/providers`
  - response: `SystemProviderInfo[]`
- `GET /system/environment`
  - response: `SystemEnvironmentInfo`
- `GET /system/environments`
  - response: `SystemEnvironmentInfo[]`

## WebSocket Contract

Endpoint: `/ws`

Client messages:

- `subscribe` with `{ entity: "thread", id?: string }`
- `unsubscribe` with `{ entity: "thread", id?: string }`

Server messages:

- `changed` with `{ entity: "thread", id?: string }`
