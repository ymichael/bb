import type { Hono } from "hono";
import { hc } from "hono/client";
import type {
  AvailableModel,
  Environment,
  Host,
  Project,
  ProjectSource,
  Thread,
  ThreadEventRow,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  ThreadType,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  EmptyInput,
  Endpoint,
  PathId,
  PathProjectId,
  PathThreadAndDraft,
  PathThreadAndQueued,
  Untyped,
} from "./common.js";
import type {
  CreateProjectRequest,
  CreateDraftRequest,
  CreateThreadRequest,
  EnqueueThreadMessageRequest,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentOperationRequest,
  EnvironmentOperationResponse,
  OpenPathRequest,
  OpenThreadPathRequest,
  PrimaryCheckoutStatus,
  ProjectFileSuggestion,
  SendDraftRequest,
  SendDraftResponse,
  SendMessageRequest,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
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
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UploadedPromptAttachment,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

export type PublicApiSchema = {
  // --- Projects ---
  "/projects": {
    $get: Endpoint<EmptyInput, Project[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, Project, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, Project>;
    $patch: Endpoint<PathProjectId & { json: UpdateProjectRequest }, Project>;
    $delete: Endpoint<PathProjectId, { ok: true }>;
  };
  "/projects/:id/sources": {
    $get: Endpoint<PathProjectId, ProjectSource[]>;
  };
  "/projects/:id/managers": {
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
  "/projects/:id/work-status": {
    $get: Endpoint<PathProjectId, WorkspaceStatus>;
  };
  "/projects/:id/workspace-status": {
    $get: Endpoint<PathProjectId, WorkspaceStatus>;
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

  // --- Hosts ---
  "/hosts": {
    $get: Endpoint<EmptyInput, Host[]>;
  };
  "/hosts/:id": {
    $get: Endpoint<PathId, Host>;
  };

  // --- Environments ---
  "/environments": {
    $get: Endpoint<{ query?: { projectId?: string } }, Environment[]>;
  };
  "/environments/:id": {
    $get:
      | Endpoint<PathId, Environment, 200>
      | Endpoint<PathId, ApiError, 404>;
  };
  "/environments/:id/actions": {
    $post:
      | Endpoint<
          PathId & { json: EnvironmentActionRequest },
          EnvironmentActionResponse,
          200
        >
      | Endpoint<
          PathId & { json: EnvironmentActionRequest },
          EnvironmentActionApiError,
          409
        >
      | Endpoint<
          PathId & { json: EnvironmentActionRequest },
          ApiError,
          404
        >;
  };
  "/environments/:id/operations": {
    $post:
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          EnvironmentOperationResponse,
          200
        >
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          EnvironmentActionApiError,
          409
        >
      | Endpoint<
          PathId & { json: EnvironmentOperationRequest },
          ApiError,
          404
        >;
  };
  "/environments/:id/primary-status": {
    $get: Endpoint<PathId, PrimaryCheckoutStatus>;
  };
  "/environments/:id/env-daemon/sessions": {
    $get: Endpoint<PathId, Untyped>;
  };

  // --- Threads ---
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
    $post: Endpoint<{ json: CreateThreadRequest }, Thread, 201>;
  };
  "/threads/:id": {
    $get: Endpoint<PathId, Thread>;
    $patch: Endpoint<PathId & { json: UpdateThreadRequest }, Thread>;
    $delete: Endpoint<PathId, { ok: true }>;
  };
  "/threads/:id/default-execution-options": {
    $get: Endpoint<PathId, ThreadExecutionOptions | null>;
  };
  "/threads/:id/open-path": {
    $post: Endpoint<PathId & { json: OpenThreadPathRequest }, { ok: true }>;
  };
  "/threads/:id/manager-workspace/files": {
    $get: Endpoint<PathId, { files: Array<{ path: string; size: number }> }>;
  };
  "/threads/:id/manager-workspace/file": {
    $get: Endpoint<PathId & { query: { path: string } }, { path: string; content: string }>;
  };
  "/threads/:id/send": {
    $post: Endpoint<PathId & { json: SendMessageRequest }, { ok: true }>;
  };
  "/threads/:id/tell": {
    $post: Endpoint<PathId & { json: TellThreadRequest }, { ok: true }>;
  };
  "/threads/:id/drafts": {
    $post: Endpoint<PathId & { json: CreateDraftRequest }, ThreadQueuedMessage, 201>;
  };
  "/threads/:id/queue": {
    $post: Endpoint<PathId & { json: EnqueueThreadMessageRequest }, ThreadQueuedMessage, 201>;
  };
  "/threads/:id/drafts/:draftId/send": {
    $post: Endpoint<
      PathThreadAndDraft & { json: SendDraftRequest },
      SendDraftResponse
    >;
  };
  "/threads/:id/queue/:queuedMessageId/send": {
    $post: Endpoint<
      PathThreadAndQueued & { json: SendQueuedThreadMessageRequest },
      SendQueuedThreadMessageResponse
    >;
  };
  "/threads/:id/drafts/:draftId": {
    $delete: Endpoint<PathThreadAndDraft, { ok: true }>;
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
    $get: Endpoint<PathId & { query?: { mergeBaseBranch?: string } }, WorkspaceStatus | null>;
  };
  "/threads/:id/primary-status": {
    $get: Endpoint<PathId, PrimaryCheckoutStatus>;
  };
  "/threads/:id/diff/branches": {
    $get: Endpoint<PathId, string[]>;
  };
  "/threads/:id/merge-base-branches": {
    $get: Endpoint<PathId, string[]>;
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
  "/threads/:id/timeline/tool-details": {
    $get: Endpoint<
      PathId & {
        query: {
          turnId: string;
          sourceSeqStart: string;
          sourceSeqEnd: string;
          includeManagerDebugView?: "true" | "false";
        };
      },
      TimelineToolDetailsResponse
    >;
  };
  "/threads/:id/diff": {
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
  "/threads/:id/output": {
    $get: Endpoint<PathId, { output: string | null }>;
  };

  // --- System ---
  "/system/status": {
    $get: Endpoint<EmptyInput, SystemStatus>;
  };
  "/system/health": {
    $get: Endpoint<EmptyInput, SystemHealthReport>;
  };
  "/system/environments": {
    $get: Endpoint<EmptyInput, SystemEnvironmentInfo[]>;
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
  "/system/restart-policy": {
    $get: Endpoint<EmptyInput, SystemRestartPolicy>;
  };
  "/system/restart": {
    $post:
      | Endpoint<{ json: SystemRestartRequest }, SystemRestartAcceptedResponse, 200>
      | Endpoint<{ json: SystemRestartRequest }, SystemShutdownBlockedResponse, 409>;
  };
  "/system/shutdown": {
    $post:
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownAcceptedResponse, 200>
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownBlockedResponse, 409>;
  };
  "/system/pick-folder": {
    $post: Endpoint<EmptyInput, { path: string | null }>;
  };
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
