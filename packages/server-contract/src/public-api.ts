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
  ProjectSource,
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
  CreateProjectSourceRequest,
  CreateThreadRequest,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusResponse,
  ProjectFileSuggestion,
  ProjectResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendMessageRequest,
  SystemConfigResponse,
  SystemProviderInfo,
  SystemVoiceTranscriptionResponse,
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UpdateThreadRequest,
  UploadedPromptAttachment,
  WorkspaceFile,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

type PathProjectSourceId = { param: { id: string; sourceId: string } };

export type PublicApiSchema = {
  // ─── Projects ────────────────────────────────────────────────────────

  "/projects": {
    $get: Endpoint<EmptyInput, ProjectResponse[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, ProjectResponse, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, ProjectResponse>;
    $patch: Endpoint<PathProjectId & { json: UpdateProjectRequest }, ProjectResponse>;
    /** Also cleans up attachment files for the project. */
    $delete: Endpoint<PathProjectId, { ok: true }>;
  };
  "/projects/:id/sources": {
    $post: Endpoint<PathProjectId & { json: CreateProjectSourceRequest }, ProjectSource, 201>;
  };
  "/projects/:id/sources/:sourceId": {
    $patch: Endpoint<PathProjectSourceId & { json: UpdateProjectSourceRequest }, ProjectSource>;
    $delete: Endpoint<PathProjectSourceId, { ok: true }>;
  };
  "/projects/:id/files": {
    /**
     * Search files in the project. Used for file mentions in the prompt box.
     * Proxies to `workspace.list_files` on the project's default source host.
     */
    $get: Endpoint<
      PathProjectId & { query: { query?: string; limit?: string } },
      ProjectFileSuggestion[]
    >;
  };
  "/projects/:id/attachments": {
    /** Upload a file attachment. Used to attach files to user messages. */
    $post: Endpoint<
      PathProjectId & { form: Record<string, string | Blob> },
      UploadedPromptAttachment,
      201
    >;
  };
  "/projects/:id/attachments/content": {
    /** Serve an uploaded attachment's content. Used to render attachment previews. */
    $get: Endpoint<
      PathProjectId & { query: { path: string } },
      string,
      200,
      "text"
    >;
  };
  "/projects/:id/managers": {
    /** Create a manager thread for the project. Same flow as POST /threads with type="manager". */
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

  // ─── Hosts ───────────────────────────────────────────────────────────

  /** Host `status` is derived at query time from the `host_daemon_sessions` table. */
  "/hosts": {
    $get: Endpoint<EmptyInput, Host[]>;
  };
  "/hosts/:id": {
    $get: Endpoint<PathId, Host>;
  };

  // ─── Environments ────────────────────────────────────────────────────

  "/environments/:id": {
    $get:
      | Endpoint<PathId, Environment, 200>
      | Endpoint<PathId, ApiError, 404>;
  };
  "/environments/:id/status": {
    /** Get workspace status (git state) for an environment. Proxies to `workspace.status`. */
    $get: Endpoint<
      PathId & { query?: { mergeBaseBranch?: string } },
      EnvironmentStatusResponse
    >;
  };
  "/environments/:id/diff": {
    /** Get git diff for an environment's workspace. Proxies to `workspace.diff`. */
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
  "/environments/:id/diff/branches": {
    /** List git branches. Proxies to `workspace.list_branches`. */
    $get: Endpoint<PathId, string[]>;
  };
  "/environments/:id/actions": {
    /**
     * Execute an environment action (commit, squash_merge, promote, demote).
     * Returns 409 if blocked by environment state.
     */
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

  // ─── Threads ─────────────────────────────────────────────────────────

  "/threads": {
    /** List threads. Supports filters: projectId, type, parentThreadId, archived. */
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
    /**
     * Create a thread with environment provisioning.
     *
     * Environment type determines the flow:
     * - "reuse": attaches to an existing environment.
     * - "host" + unmanaged/managed-worktree/managed-clone: provisions a new environment.
     * - "sandbox-host": returns 501 (not yet implemented).
     *
     * If input is provided, the thread starts automatically after provisioning.
     * A title is generated asynchronously if not provided.
     */
    $post: Endpoint<{ json: CreateThreadRequest }, Thread, 201>;
  };
  "/threads/:id": {
    $get: Endpoint<PathId, Thread>;
    /** Update thread metadata. If the title changes, also notifies the provider via `thread.rename`. */
    $patch: Endpoint<PathId & { json: UpdateThreadRequest }, Thread>;
    /** Delete a thread. Also destroys its environment if one exists. */
    $delete: Endpoint<PathId, { ok: true }>;
  };
  "/threads/:id/send": {
    /**
     * Send a message to a thread.
     * Idle thread → starts a new turn. Active thread with mode=steer → steers the current turn.
     */
    $post: Endpoint<PathId & { json: SendMessageRequest }, { ok: true }>;
  };
  "/threads/:id/drafts": {
    $post: Endpoint<PathId & { json: CreateDraftRequest }, ThreadQueuedMessage, 201>;
  };
  "/threads/:id/drafts/:draftId/send": {
    /** Send a previously created draft. Starts or steers a turn, then deletes the draft. */
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
    /**
     * Archive a thread. Rejects if uncommitted work exists (unless force=true).
     * Stops the thread if active. Cleans up managed environments with no remaining threads.
     */
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
    /** Get thread timeline for UI rendering. Events transformed via `@bb/core-ui`. */
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
    /** Get tool call details for a turn. Used by the UI to lazy-load expanded tool information. */
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
  "/threads/:id/output": {
    $get: Endpoint<PathId, { output: string | null }>;
  };
  "/threads/:id/events": {
    /** Get raw thread events. Supports `afterSeq` and `limit` pagination. */
    $get: Endpoint<PathId & { query?: { afterSeq?: string; limit?: string } }, ThreadEventRow[]>;
  };
  "/threads/:id/default-execution-options": {
    $get: Endpoint<PathId, ThreadExecutionOptions | null>;
  };
  "/threads/:id/workspace/files": {
    /**
     * List files in the thread's workspace.
     * Resolves thread -> environmentId -> environment -> hostId, queues
     * `workspace.list_files` to the host daemon, and waits for the result.
     */
    $get: Endpoint<
      PathId & { query?: { query?: string; limit?: string } },
      WorkspaceFile[]
    >;
  };
  "/threads/:id/workspace/file": {
    /** Read a single file from the thread's workspace. Proxies to `workspace.read_file`. */
    $get: Endpoint<
      PathId & { query: { path: string } },
      { path: string; content: string }
    >;
  };

  // ─── System ──────────────────────────────────────────────────────────

  "/system/config": {
    $get: Endpoint<EmptyInput, SystemConfigResponse>;
  };
  "/system/models": {
    /** List available models. Proxies to `provider.list_models`. Can target a specific host or environment. */
    $get: Endpoint<
      { query?: { providerId?: string; hostId?: string; environmentId?: string } },
      AvailableModel[]
    >;
  };
  "/system/providers": {
    /** List available providers. Proxies to `provider.list`. Can target a specific host or environment. */
    $get: Endpoint<
      { query?: { hostId?: string; environmentId?: string } },
      SystemProviderInfo[]
    >;
  };
  "/system/voice-transcription": {
    /** Transcribe audio to text. Accepts audio file and optional prompt context. */
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
