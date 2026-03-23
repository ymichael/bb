import type { Hono } from "hono";
import { hc } from "hono/client";
import type { EnvironmentDaemonSessionListResponse } from "@bb/env-daemon-contract";
import type {
  AvailableModel,
  EnvironmentRecord,
  Project,
  Thread,
  ThreadEventRow,
  ThreadExecutionOptions,
  ThreadQueuedMessage,
  ThreadGitDiffResponse,
  ThreadType,
  ThreadWorkStatus,
} from "@bb/domain";
import type { EmptyInput, Endpoint, PathId, PathProjectId, PathThreadAndQueued } from "./common.js";
import type {
  CreateProjectRequest,
  EnqueueThreadMessageRequest,
  EnvironmentOperationApiError,
  EnvironmentOperationRequest,
  EnvironmentOperationResponse,
  OpenPathRequest,
  OpenThreadPathRequest,
  PrimaryCheckoutStatus,
  ProjectFileSuggestion,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
  SpawnThreadRequest,
  SystemEnvironmentInfo,
  SystemHealthReport,
  SystemProviderInfo,
  SystemRestartAcceptedResponse,
  SystemRestartPolicy,
  SystemRestartRequest,
  SystemShutdownAcceptedResponse,
  SystemShutdownBlockedResponse,
  SystemShutdownRequest,
  SystemStatus,
  SystemVoiceTranscriptionResponse,
  TellThreadRequest,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UploadedPromptAttachment,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

export type PublicApiSchema = {
  "/projects": {
    $get: Endpoint<EmptyInput, Project[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, Project, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, Project>;
    $patch: Endpoint<PathProjectId & { json: UpdateProjectRequest }, Project>;
    $delete: Endpoint<PathProjectId, { ok: true }>;
  };
  /** Spawns a new manager thread for this project. A manager is a supervisory
   *  thread (type: "manager") that can coordinate sub-threads and has its own
   *  inspectable workspace via the manager-workspace endpoints. */
  "/projects/:id/manager": {
    $post: Endpoint<
      PathProjectId & {
        json: {
          title?: string;
          providerId?: string;
          model?: string;
          reasoningLevel?: "low" | "medium" | "high" | "xhigh";
        };
      },
      Thread,
      201
    >;
  };
  "/projects/:id/files": {
    $get: Endpoint<
      PathProjectId & { query: { query?: string; limit?: string } },
      ProjectFileSuggestion[]
    >;
  };
  "/projects/:id/workspace-status": {
    $get: Endpoint<PathProjectId, ThreadWorkStatus>;
  };
  "/projects/:id/attachments": {
    $post: Endpoint<
      PathProjectId & { form: Record<string, string | Blob> },
      UploadedPromptAttachment,
      201
    >;
  };
  "/projects/:id/attachments/content": {
    $get: Endpoint<
      PathProjectId & { query: { path: string } },
      string,
      200,
      "text"
    >;
  };
  "/environments": {
    $get: Endpoint<{ query?: { projectId?: string } }, EnvironmentRecord[]>;
  };
  "/environments/:id": {
    $get:
      | Endpoint<PathId, EnvironmentRecord, 200>
      | Endpoint<PathId, ApiError, 404>;
  };
  /** Performs a git or environment lifecycle operation. Operations are a
   *  discriminated union: "promote_primary" / "demote_primary" (swap which thread
   *  owns the primary checkout), "commit" (create a git commit), or
   *  "squash_merge" (squash-merge the thread's branch). */
  "/environments/:id/operations": {
    $post:
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          EnvironmentOperationResponse,
          200
        >
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          EnvironmentOperationApiError,
          409
        >
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          ApiError,
          404
        >;
  };
  "/environments/:id/env-daemon/sessions": {
    $get: Endpoint<PathId, EnvironmentDaemonSessionListResponse>;
  };
  "/threads": {
    $get: Endpoint<
      {
        query?: {
          projectId?: string;
          type?: ThreadType;
          parentThreadId?: string;
          includeArchived?: "true" | "false";
          includeWorkStatus?: "true" | "false";
        };
      },
      Thread[]
    >;
    $post: Endpoint<{ json: SpawnThreadRequest }, Thread, 201>;
  };
  "/threads/:id": {
    $get: Endpoint<PathId, Thread>;
    $patch: Endpoint<PathId & { json: UpdateThreadRequest }, Thread>;
    $delete: Endpoint<PathId, { ok: true }>;
  };
  /** Opens a file or directory from the thread's workspace in the user's
   *  editor. Accepts a path relative to the workspace root, a target type
   *  (file/directory), and an optional editor preference
   *  (vscode/cursor/zed/windsurf/system_default). */
  "/threads/:id/open-path": {
    $post: Endpoint<PathId & { json: OpenThreadPathRequest }, { ok: true }>;
  };
  "/threads/:id/default-execution-options": {
    $get: Endpoint<PathId, ThreadExecutionOptions | null>;
  };
  /** Lists files in a manager thread's internal workspace. Manager threads have
   *  a dedicated workspace for their own working state, separate from the
   *  project's primary checkout. */
  "/threads/:id/manager-workspace/files": {
    $get: Endpoint<PathId, { files: Array<{ path: string; size: number }> }>;
  };
  /** Returns the content of a single file from a manager thread's workspace. */
  "/threads/:id/manager-workspace/file": {
    $get: Endpoint<PathId & { query: { path: string } }, { path: string; content: string }>;
  };
  /** Sends a prompt message to an active thread. This is the primary way to
   *  interact with a running thread — mode controls whether to start a new turn
   *  ("start"/"auto") or steer the current one ("steer"). Only meaningful when
   *  the thread has an active session. */
  "/threads/:id/tell": {
    $post: Endpoint<PathId & { json: TellThreadRequest }, { ok: true }>;
  };
  /** Enqueues a message for later delivery. Used when composing a message while
   *  the thread is busy — the message is stored in the thread's queuedMessages
   *  array and can be sent later via the /send endpoint. */
  "/threads/:id/queue": {
    $post: Endpoint<PathId & { json: EnqueueThreadMessageRequest }, ThreadQueuedMessage, 201>;
  };
  /** Sends a previously queued message to the thread. Mode controls turn
   *  behavior: "auto" starts a new turn, "steer-if-active" steers only if a
   *  turn is already running, "steer" always steers. */
  "/threads/:id/queue/:queuedMessageId/send": {
    $post: Endpoint<
      PathThreadAndQueued & { json: SendQueuedThreadMessageRequest },
      SendQueuedThreadMessageResponse
    >;
  };
  "/threads/:id/queue/:queuedMessageId": {
    $delete: Endpoint<PathThreadAndQueued, { ok: true }>;
  };
  "/threads/:id/stop": {
    $post: Endpoint<PathId, { ok: true }>;
  };
  "/threads/:id/archive": {
    $post: Endpoint<PathId & { json: { force?: boolean } }, { ok: true }>;
  };
  "/threads/:id/unarchive": {
    $post: Endpoint<PathId, { ok: true }>;
  };
  "/threads/:id/read": {
    $post: Endpoint<PathId, Thread>;
  };
  "/threads/:id/unread": {
    $post: Endpoint<PathId, Thread>;
  };
  "/threads/:id/work-status": {
    $get: Endpoint<PathId & { query?: { mergeBaseBranch?: string } }, ThreadWorkStatus | null>;
  };
  /** Returns candidate git branch names for merge-base diff comparisons. Used by
   *  the diff UI to let the user choose which branch to compare against. */
  "/threads/:id/merge-base-branches": {
    $get: Endpoint<PathId, string[]>;
  };
  /** Returns which thread/environment is the "primary checkout" for the project —
   *  the active working branch whose workspace is synced to the user's editor. */
  "/threads/:id/primary-status": {
    $get: Endpoint<PathId, PrimaryCheckoutStatus>;
  };
  "/threads/:id/timeline": {
    $get: Endpoint<
      PathId & {
        query?: {
          limit?: string;
          includeToolGroupMessages?: "true" | "false";
          includeManagerDebugView?: "true" | "false";
        };
      },
      ThreadTimelineResponse
    >;
  };
  /** Lazily loads detailed tool call/response messages for a specific turn within
   *  a thread. A "tool group" is a collapsed sequence of tool calls within a
   *  turn, identified by the turn ID and source event sequence range. */
  "/threads/:id/tool-group-messages": {
    $get: Endpoint<
      PathId & {
        query: {
          turnId: string;
          sourceSeqStart: string;
          sourceSeqEnd: string;
          includeManagerDebugView?: "true" | "false";
        };
      },
      ThreadToolGroupMessagesResponse
    >;
  };
  "/threads/:id/git-diff": {
    $get: Endpoint<
      PathId & {
        query?: {
          selection?: "combined" | "commit";
          commitSha?: string;
          mergeBaseBranch?: string;
        };
      },
      ThreadGitDiffResponse
    >;
  };
  "/threads/:id/events": {
    $get: Endpoint<PathId & { query?: { afterSeq?: string; limit?: string } }, ThreadEventRow[]>;
  };
  /** Returns the thread's final output string, or null if the thread has not
   *  produced output. */
  "/threads/:id/output": {
    $get: Endpoint<PathId, { output: string | null }>;
  };
  "/system/status": {
    $get: Endpoint<EmptyInput, SystemStatus>;
  };
  "/system/health": {
    $get: Endpoint<EmptyInput, SystemHealthReport>;
  };
  "/system/models": {
    $get: Endpoint<
      { query?: { providerId?: string; environmentId?: string } },
      AvailableModel[]
    >;
  };
  "/system/provider": {
    $get: Endpoint<{ query?: { environmentId?: string } }, SystemProviderInfo>;
  };
  "/system/providers": {
    $get: Endpoint<{ query?: { environmentId?: string } }, SystemProviderInfo[]>;
  };
  "/system/environments": {
    $get: Endpoint<EmptyInput, SystemEnvironmentInfo[]>;
  };
  "/system/restart-policy": {
    $get: Endpoint<EmptyInput, SystemRestartPolicy>;
  };
  "/system/shutdown": {
    $post:
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownAcceptedResponse, 200>
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownBlockedResponse, 409>;
  };
  "/system/restart": {
    $post:
      | Endpoint<{ json: SystemRestartRequest }, SystemRestartAcceptedResponse, 200>
      | Endpoint<{ json: SystemRestartRequest }, SystemShutdownBlockedResponse, 409>;
  };
  /** Opens the OS native folder-picker dialog and returns the selected absolute
   *  path, or null if the user cancels. Used when creating a new project to
   *  select the project root directory. */
  "/system/pick-folder": {
    $post: Endpoint<EmptyInput, { path: string | null }>;
  };
  /** Opens an absolute file or directory path in the user's editor. Same editor
   *  options as the thread-scoped variant but not bound to a workspace. */
  "/system/open-path": {
    $post: Endpoint<{ json: OpenPathRequest }, { ok: true }>;
  };
  "/system/voice-transcription": {
    $post: Endpoint<{ form: Record<string, string | Blob> }, SystemVoiceTranscriptionResponse>;
  };
};

export type PublicApiRoutes = Hono<{}, PublicApiSchema, "/">;

export function createPublicApiClient(baseUrl: string) {
  return hc<PublicApiRoutes>(`${baseUrl}/api/v1`);
}

export function createApiClient(baseUrl: string) {
  const apiClient = createPublicApiClient(baseUrl);
  return {
    api: {
      v1: apiClient,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
