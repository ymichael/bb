import type { Hono } from "hono";
import { hc } from "hono/client";
import type {
  AvailableModel,
  Environment,
  Host,
  Thread,
  ThreadEventRow,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  ThreadType,
} from "@bb/domain";
import type {
  EmptyInput,
  Endpoint,
  PathId,
  PathProjectId,
  PathThreadAndDraft,
} from "./common.js";
import type {
  CreateDraftRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusResponse,
  ProjectResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendMessageRequest,
  SystemProviderInfo,
  SystemShutdownAcceptedResponse,
  SystemShutdownBlockedResponse,
  SystemShutdownRequest,
  SystemVoiceTranscriptionResponse,
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UpdateThreadRequest,
  WorkspaceFile,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

export type PublicApiSchema = {
  "/projects": {
    $get: Endpoint<EmptyInput, ProjectResponse[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, ProjectResponse, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, ProjectResponse>;
    $patch: Endpoint<PathProjectId & { json: UpdateProjectRequest }, ProjectResponse>;
    $delete: Endpoint<PathProjectId, { ok: true }>;
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


  "/hosts": {
    $get: Endpoint<EmptyInput, Host[]>;
  };
  "/hosts/:id": {
    $get: Endpoint<PathId, Host>;
  };

  "/environments": {
    $get: Endpoint<{ query?: { projectId?: string } }, Environment[]>;
  };
  "/environments/:id": {
    $get:
      | Endpoint<PathId, Environment, 200>
      | Endpoint<PathId, ApiError, 404>;
  };
  "/environments/:id/status": {
    $get: Endpoint<
      PathId & { query?: { mergeBaseBranch?: string } },
      EnvironmentStatusResponse
    >;
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
      | Endpoint<PathId & { json: EnvironmentActionRequest }, ApiError, 404>;
  };

  "/threads": {
    $get: Endpoint<
      {
        query?: {
          projectId?: string;
          type?: ThreadType;
          parentThreadId?: string;
          archived?: "true" | "false";
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
  "/threads/:id/send": {
    $post: Endpoint<PathId & { json: SendMessageRequest }, { ok: true }>;
  };
  "/threads/:id/drafts": {
    $post: Endpoint<PathId & { json: CreateDraftRequest }, ThreadQueuedMessage, 201>;
  };
  "/threads/:id/drafts/:draftId/send": {
    $post: Endpoint<
      PathThreadAndDraft & { json: SendDraftRequest },
      SendDraftResponse
    >;
  };
  "/threads/:id/drafts/:draftId": {
    $delete: Endpoint<PathThreadAndDraft, { ok: true }>;
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
  "/threads/:id/timeline": {
    $get: Endpoint<
      PathId & {
        query?: {
          limit?: string;
          includeManagerDebugView?: "true" | "false";
        };
      },
      ThreadTimelineResponse
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
          selection?: string;
          mergeBaseBranch?: string;
        };
      },
      ThreadGitDiffResponse
    >;
  };
  "/threads/:id/diff/branches": {
    $get: Endpoint<PathId, string[]>;
  };
  "/threads/:id/output": {
    $get: Endpoint<PathId, { output: string | null }>;
  };
  "/threads/:id/events": {
    $get: Endpoint<PathId & { query?: { afterSeq?: string; limit?: string } }, ThreadEventRow[]>;
  };
  "/threads/:id/default-execution-options": {
    $get: Endpoint<PathId, ThreadExecutionOptions | null>;
  };
  "/threads/:id/workspace/files": {
    $get: Endpoint<
      PathId & { query?: { query?: string; limit?: string } },
      WorkspaceFile[]
    >;
  };
  "/threads/:id/workspace/file": {
    $get: Endpoint<
      PathId & { query: { path: string } },
      { path: string; content: string }
    >;
  };

  "/system/models": {
    $get: Endpoint<
      { query?: { providerId?: string; environmentId?: string } },
      AvailableModel[]
    >;
  };
  "/system/providers": {
    $get: Endpoint<{ query?: { environmentId?: string } }, SystemProviderInfo[]>;
  };
  "/system/providers/:id": {
    $get: Endpoint<PathId, SystemProviderInfo>;
  };
  "/system/shutdown": {
    $post:
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownAcceptedResponse, 200>
      | Endpoint<{ json: SystemShutdownRequest }, SystemShutdownBlockedResponse, 409>;
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
