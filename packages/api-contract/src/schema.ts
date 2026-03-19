import type { Hono } from "hono";
import type {
  CommitEnvironmentOperationResponse,
  CreateProjectRequest,
  EnqueueThreadMessageRequest,
  EnvironmentOperationRequest,
  EnvironmentOperationResponse,
  EnvironmentRecord,
  DemotePrimaryCheckoutResponse,
  OpenPathRequest,
  OpenThreadPathRequest,
  PrimaryCheckoutStatus,
  Project,
  ProjectFileSuggestion,
  PromotePrimaryCheckoutResponse,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
  SpawnThreadRequest,
  SquashMergeEnvironmentOperationResponse,
  SystemEnvironmentInfo,
  SystemHealthReport,
  SystemProviderInfo,
  SystemShutdownBlockedResponse,
  SystemRestartPolicy,
  SystemRestartRequest,
  SystemRestartAcceptedResponse,
  SystemShutdownAcceptedResponse,
  SystemShutdownRequest,
  SystemStatus,
  TellThreadRequest,
  Thread,
  ThreadEvent,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
  ThreadType,
  ThreadWorkStatus,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UploadedPromptAttachment,
} from "@bb/core";

type Endpoint<
  Input,
  Output = unknown,
  Status extends number = 200,
  Format extends "json" | "text" = "json",
> = {
  input: Input;
  output: Output;
  outputFormat: Format;
  status: Status;
};

type EmptyInput = Record<never, never>;
type PathId = { param: { id: string } };
type PathProjectId = { param: { id: string } };
type PathThreadAndQueued = { param: { id: string; queuedMessageId: string } };

export type ApiSchema = {
  "/projects": {
    $get: Endpoint<EmptyInput, Project[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, Project, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, Project>;
    $patch: Endpoint<PathProjectId & { json: UpdateProjectRequest }, Project>;
    $delete: Endpoint<PathProjectId, { ok: true }>;
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
    $get: Endpoint<PathId, EnvironmentRecord | null, 200 | 404>;
  };
  "/environments/:id/operations": {
    $post: Endpoint<
      PathId & { json: EnvironmentOperationRequest },
      EnvironmentOperationResponse | { error: string } | null,
      200 | 404
    >;
  };
  "/environments/:id/env-daemon/status": {
    $get: Endpoint<PathId, unknown>;
  };
  "/environments/:id/env-daemon/sessions": {
    $get: Endpoint<PathId, unknown>;
  };
  "/environments/:id/env-daemon/session/open": {
    $post: Endpoint<{ param: { id: string }; json: unknown }, unknown, 201>;
  };
  "/environments/:id/env-daemon/session/commands": {
    $get: Endpoint<
      PathId & {
        query: {
          sessionId: string;
          afterCursor?: string;
          limit?: string;
          waitMs?: string;
        };
      },
      unknown
    >;
  };
  "/environments/:id/env-daemon/session/messages": {
    $post: Endpoint<{ param: { id: string }; json: unknown }, unknown, 200 | 204>;
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
  "/threads/:id/open-path": {
    $post: Endpoint<PathId & { json: OpenThreadPathRequest }, { ok: true }>;
  };
  "/threads/:id/default-execution-options": {
    $get: Endpoint<PathId, ThreadExecutionOptions | null>;
  };
  "/threads/:id/manager-workspace/files": {
    $get: Endpoint<PathId, { files: Array<{ path: string; size: number }> }>;
  };
  "/threads/:id/manager-workspace/file": {
    $get: Endpoint<PathId & { query: { path: string } }, { path: string; content: string }>;
  };
  "/threads/:id/env-daemon/status": {
    $get: Endpoint<PathId, unknown>;
  };
  "/threads/:id/env-daemon/sessions": {
    $get: Endpoint<PathId, unknown>;
  };
  "/threads/:id/tell": {
    $post: Endpoint<PathId & { json: TellThreadRequest }, { ok: true }>;
  };
  "/threads/:id/queue": {
    $post: Endpoint<PathId & { json: EnqueueThreadMessageRequest }, ThreadQueuedMessage, 201>;
  };
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
  "/threads/:id/merge-base-branches": {
    $get: Endpoint<PathId, string[]>;
  };
  "/threads/:id/primary-status": {
    $get: Endpoint<PathId, PrimaryCheckoutStatus>;
  };
  "/threads/:id/timeline": {
    $get: Endpoint<
      PathId & {
        query?: {
          limit?: string;
          includeToolGroupMessages?: "true";
          includeManagerDebugView?: "true";
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
          includeManagerDebugView?: "true";
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
    $get: Endpoint<PathId & { query?: { afterSeq?: string; limit?: string } }, ThreadEvent[]>;
  };
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
    $get: Endpoint<{ query?: { providerId?: string } }, unknown>;
  };
  "/system/provider": {
    $get: Endpoint<EmptyInput, SystemProviderInfo>;
  };
  "/system/providers": {
    $get: Endpoint<EmptyInput, SystemProviderInfo[]>;
  };
  "/system/environments": {
    $get: Endpoint<EmptyInput, SystemEnvironmentInfo[]>;
  };
  "/system/restart-policy": {
    $get: Endpoint<EmptyInput, SystemRestartPolicy>;
  };
  "/system/shutdown": {
    $post: Endpoint<
      { json: SystemShutdownRequest },
      SystemShutdownAcceptedResponse | SystemShutdownBlockedResponse,
      200 | 409
    >;
  };
  "/system/restart": {
    $post: Endpoint<
      { json: SystemRestartRequest },
      SystemRestartAcceptedResponse | SystemShutdownBlockedResponse,
      200 | 409
    >;
  };
  "/system/pick-folder": {
    $post: Endpoint<EmptyInput, { path: string | null }>;
  };
  "/system/open-path": {
    $post: Endpoint<{ json: OpenPathRequest }, { ok: true }>;
  };
  "/system/voice-transcription": {
    $post: Endpoint<{ form: Record<string, string | Blob> }, unknown>;
  };
};

export type ApiRoutesType = Hono<{}, ApiSchema, "/">;
