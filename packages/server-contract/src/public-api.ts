import type { Hono } from "hono";
import { hc } from "hono/client";
import type {
  AvailableModel,
  Environment,
  Host,
  PendingInteraction,
  ProjectExecutionDefaults,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadEventRow,
  ThreadGitDiffResponse,
  ProjectSource,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  EmptyInput,
  Endpoint,
  PathAttemptId,
  PathId,
  PathProjectAutomationId,
  PathProjectId,
  PathProviderId,
  PathThreadAndDraft,
} from "./common.js";
import type {
  ArchiveThreadRequest,
  Automation,
  CloudAuthAttemptResponse,
  CloudAuthConnectRequest,
  CloudAuthConnectResponse,
  CloudAuthSettingsResponse,
  CreateAutomationRequest,
  CreateHostJoinRequest,
  CreateHostJoinResponse,
  CreateDraftRequest,
  CreateManagerThreadRequest,
  CreateProjectRequest,
  CreateProjectSourceRequest,
  CreateThreadRequest,
  EnvironmentDiffQuery,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentPromotionResponse,
  EnvironmentStatusQuery,
  EnvironmentStatusResponse,
  ThreadStorageContentQuery,
  ThreadStorageFilesQuery,
  ProjectAttachmentContentQuery,
  ProjectDefaultExecutionOptionsQuery,
  ProjectAttachmentUploadForm,
  ProjectFilesQuery,
  ProjectResponse,
  ProjectSourceWorkspaceStatusResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendMessageRequest,
  ResolvePendingInteractionRequest,
  ThreadDraftListResponse,
  GithubRepoInfo,
  GithubReposQuery,
  SandboxEnvVar,
  SandboxEnvVarName,
  SandboxEnvVarsResponse,
  SystemConfigResponse,
  SystemSandboxBackendInfo,
  SystemModelsQuery,
  SystemProviderInfo,
  SystemProvidersQuery,
  SystemVoiceTranscriptionForm,
  SystemVoiceTranscriptionResponse,
  ThreadEventWaitQuery,
  ThreadEventsQuery,
  ThreadListQuery,
  ThreadListResponse,
  ThreadPendingInteractionsResponse,
  ThreadTimelineQuery,
  ThreadTimelineResponse,
  TimelineToolDetailsQuery,
  TimelineToolDetailsResponse,
  UpdateAutomationRequest,
  UpdateEnvironmentRequest,
  UpdateHostRequest,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UpdateThreadRequest,
  UpsertSandboxEnvVarRequest,
  UploadedPromptAttachment,
  WorkspaceFileListResponse,
  ReplayCaptureListResponse,
  ReplayRunRequest,
  ReplayRunResponse,
} from "./api-types.js";
import type { ApiError } from "./errors.js";

type PathProjectSourceId = { param: { id: string; sourceId: string } };

export type PublicApiSchema = {
  // ─── Development Only ────────────────────────────────────────────────

  "/development-only/replay/captures": {
    $get: Endpoint<EmptyInput, ReplayCaptureListResponse>;
  };
  "/development-only/replay/captures/:id": {
    $delete: Endpoint<PathId, { ok: true }>;
  };
  "/development-only/replay/captures/:id/runs": {
    $post: Endpoint<
      PathId & { json: ReplayRunRequest },
      ReplayRunResponse,
      201
    >;
  };

  // ─── Projects ────────────────────────────────────────────────────────

  "/projects": {
    $get: Endpoint<EmptyInput, ProjectResponse[]>;
    $post: Endpoint<{ json: CreateProjectRequest }, ProjectResponse, 201>;
  };
  "/projects/:id": {
    $get: Endpoint<PathProjectId, ProjectResponse>;
    $patch: Endpoint<
      PathProjectId & { json: UpdateProjectRequest },
      ProjectResponse
    >;
    /** Also cleans up attachment files for the project. */
    $delete: Endpoint<PathProjectId, { ok: true }>;
  };
  "/projects/:id/default-execution-options": {
    /** Returns the last remembered provider and execution options for the project and thread type. */
    $get: Endpoint<
      PathProjectId & { query: ProjectDefaultExecutionOptionsQuery },
      ProjectExecutionDefaults | null
    >;
  };
  "/projects/:id/sources": {
    $post: Endpoint<
      PathProjectId & { json: CreateProjectSourceRequest },
      ProjectSource,
      201
    >;
  };
  "/projects/:id/sources/:sourceId": {
    $patch: Endpoint<
      PathProjectSourceId & { json: UpdateProjectSourceRequest },
      ProjectSource
    >;
    $delete: Endpoint<PathProjectSourceId, { ok: true }>;
  };
  "/projects/:id/sources/:sourceId/status": {
    /** Return git workspace status for a local path project source primary checkout. */
    $get: Endpoint<PathProjectSourceId, ProjectSourceWorkspaceStatusResponse>;
  };
  "/projects/:id/automations": {
    $get: Endpoint<PathProjectId, Automation[]>;
    $post: Endpoint<
      PathProjectId & { json: CreateAutomationRequest },
      Automation,
      201
    >;
  };
  "/projects/:id/automations/:automationId": {
    $patch: Endpoint<
      PathProjectAutomationId & { json: UpdateAutomationRequest },
      Automation
    >;
    $delete: Endpoint<PathProjectAutomationId, { ok: true }>;
  };
  "/projects/:id/files": {
    /**
     * Search files in the project. Used for file mentions in the prompt box.
     * Proxies to `workspace.list_files` on the project's default source host.
     */
    $get: Endpoint<
      PathProjectId & { query: ProjectFilesQuery },
      WorkspaceFileListResponse
    >;
  };
  "/projects/:id/attachments": {
    /** Upload a file attachment. Used to attach files to user messages. */
    $post: Endpoint<
      PathProjectId & { form: ProjectAttachmentUploadForm },
      UploadedPromptAttachment,
      201
    >;
  };
  "/projects/:id/attachments/content": {
    /**
     * Serve an uploaded attachment's content. Used to render attachment previews.
     *
     * Returns raw binary with the appropriate `Content-Type` header.
     * The handler constructs a `Response` directly (bypasses `context.json()`),
     * so the output type here is nominal — the actual body is a `Uint8Array`.
     */
    $get: Endpoint<
      PathProjectId & { query: ProjectAttachmentContentQuery },
      Uint8Array,
      200,
      "binary"
    >;
  };
  "/projects/:id/managers": {
    /** Create a manager thread for the project. Same flow as POST /threads with type="manager". */
    $post: Endpoint<
      PathProjectId & { json: CreateManagerThreadRequest },
      Thread,
      201
    >;
  };

  // ─── Hosts ───────────────────────────────────────────────────────────

  /** Host `status` is derived at query time from the `host_daemon_sessions` table. */
  "/hosts": {
    $get: Endpoint<EmptyInput, Host[]>;
  };
  "/hosts/join": {
    $post: Endpoint<
      { json: CreateHostJoinRequest },
      CreateHostJoinResponse,
      201
    >;
  };
  "/hosts/:id": {
    $get: Endpoint<PathId, Host>;
    $patch: Endpoint<PathId & { json: UpdateHostRequest }, Host>;
    $delete: Endpoint<PathId, { ok: true }>;
  };

  // ─── Environments ────────────────────────────────────────────────────

  "/environments/:id": {
    $get: Endpoint<PathId, Environment, 200> | Endpoint<PathId, ApiError, 404>;
    $patch: Endpoint<PathId & { json: UpdateEnvironmentRequest }, Environment>;
  };
  "/environments/:id/status": {
    /** Get workspace status (git state) for an environment. Proxies to `workspace.status`. */
    $get: Endpoint<
      PathId & { query: EnvironmentStatusQuery },
      EnvironmentStatusResponse
    >;
  };
  "/environments/:id/promotion": {
    /** Derive current promotion state and server-side action eligibility for an environment. */
    $get: Endpoint<PathId, EnvironmentPromotionResponse>;
  };
  "/environments/:id/diff": {
    /** Get git diff for an environment's workspace. Proxies to `workspace.diff`. */
    $get: Endpoint<
      PathId & { query: EnvironmentDiffQuery },
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
    $get: Endpoint<{ query?: ThreadListQuery }, ThreadListResponse>;
    /**
     * Create a thread with environment provisioning.
     *
     * Environment type determines the flow:
     * - "reuse": attaches to an existing environment.
     * - "host" + unmanaged/managed-worktree/managed-clone: provisions a new environment.
     * - "sandbox-host": provisions a new ephemeral sandbox host for cloneable project sources.
     *
     * If input is provided, the thread starts automatically after provisioning.
     * A title is generated asynchronously if not provided.
     */
    $post: Endpoint<{ json: CreateThreadRequest }, Thread, 201>;
  };
  "/threads/:id": {
    $get: Endpoint<PathId, Thread>;
    /** Update thread metadata. If the title changes, also notifies providers that support `thread.rename`. */
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
    $get: Endpoint<PathId, ThreadDraftListResponse>;
    $post: Endpoint<
      PathId & { json: CreateDraftRequest },
      ThreadQueuedMessage,
      201
    >;
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
  "/threads/:id/interactions": {
    /** List pending interactions owned by a thread. */
    $get: Endpoint<PathId, ThreadPendingInteractionsResponse>;
  };
  "/threads/:id/interactions/:interactionId": {
    /** Get a single pending interaction owned by a thread. */
    $get: Endpoint<
      { param: { id: string; interactionId: string } },
      PendingInteraction
    >;
  };
  "/threads/:id/interactions/:interactionId/resolve": {
    /** Resolve a pending interaction and return its updated lifecycle record. */
    $post: Endpoint<
      {
        param: { id: string; interactionId: string };
        json: ResolvePendingInteractionRequest;
      },
      PendingInteraction
    >;
  };
  "/threads/:id/archive": {
    /**
     * Archive a thread. Rejects if work could be lost (unless force=true) —
     * checks workspace status for uncommitted or unmerged changes.
     * Stops the thread if active. If its managed environment now has zero
     * non-archived threads, destroys the environment.
     */
    $post: Endpoint<PathId & { json: ArchiveThreadRequest }, { ok: true }>;
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
      PathId & { query?: ThreadTimelineQuery },
      ThreadTimelineResponse
    >;
  };
  "/threads/:id/timeline/tool-details": {
    /** Get tool call details for a turn. Used by the UI to lazy-load expanded tool information. */
    $get: Endpoint<
      PathId & { query: TimelineToolDetailsQuery },
      TimelineToolDetailsResponse
    >;
  };
  "/threads/:id/output": {
    $get: Endpoint<PathId, { output: string | null }>;
  };
  "/threads/:id/events": {
    /** Get raw thread events. Supports `afterSeq` and `limit` pagination. */
    $get: Endpoint<PathId & { query?: ThreadEventsQuery }, ThreadEventRow[]>;
  };
  "/threads/:id/events/wait": {
    /**
     * Long-poll for a thread event matching `type`. Returns the first matching
     * event (200) or 204 if none appears within `waitMs`.
     */
    $get: Endpoint<
      PathId & { query: ThreadEventWaitQuery },
      ThreadEventRow | null
    >;
  };
  "/threads/:id/default-execution-options": {
    /** Returns the last used options for the thread for use as defaults in the UI. */
    $get: Endpoint<PathId, ResolvedThreadExecutionOptions | null>;
  };
  "/threads/:id/thread-storage/files": {
    /**
     * List files in the durable thread storage for a thread environment.
     * Resolves the thread storage root from the active host session `dataDir`
     * and proxies to `host.list_files`.
     */
    $get: Endpoint<
      PathId & { query?: ThreadStorageFilesQuery },
      WorkspaceFileListResponse
    >;
  };
  "/threads/:id/thread-storage/content": {
    /**
     * Serve thread storage file content as raw bytes with `Content-Type`.
     * Resolves the thread storage root from the active host session `dataDir`
     * and proxies to `host.read_file`.
     */
    $get: Endpoint<
      PathId & { query: ThreadStorageContentQuery },
      Uint8Array,
      200,
      "binary"
    >;
  };

  // ─── System ──────────────────────────────────────────────────────────

  "/system/config": {
    $get: Endpoint<EmptyInput, SystemConfigResponse>;
  };
  "/system/cloud-auth": {
    /** Returns the current app-level cloud auth connection state for sandbox-compatible providers. */
    $get: Endpoint<EmptyInput, CloudAuthSettingsResponse>;
  };
  "/system/cloud-auth/:providerId/connect": {
    /**
     * Starts an app-level OAuth flow for the requested provider and returns the
     * authorization URL the UI should open in a browser.
     */
    $post: Endpoint<
      PathProviderId & { json: CloudAuthConnectRequest },
      CloudAuthConnectResponse,
      201
    >;
  };
  "/system/cloud-auth/attempts/:attemptId": {
    /** Returns the status of a previously started cloud auth connection attempt. */
    $get: Endpoint<PathAttemptId, CloudAuthAttemptResponse>;
  };
  "/system/cloud-auth/:providerId": {
    /** Removes the saved app-level cloud auth connection for the provider. */
    $delete: Endpoint<PathProviderId, { ok: true }>;
  };
  "/system/sandbox-env-vars": {
    /** Returns metadata for app-level sandbox env vars without exposing plaintext values. */
    $get: Endpoint<EmptyInput, SandboxEnvVarsResponse>;
    /** Creates or updates an app-level sandbox env var. */
    $post: Endpoint<{ json: UpsertSandboxEnvVarRequest }, SandboxEnvVar>;
  };
  "/system/sandbox-env-vars/:name": {
    /** Deletes an app-level sandbox env var. */
    $delete: Endpoint<{ param: { name: SandboxEnvVarName } }, { ok: true }>;
  };
  "/system/sandbox-backends": {
    /** List sandbox backends supported by the server. */
    $get: Endpoint<EmptyInput, SystemSandboxBackendInfo[]>;
  };
  "/system/github-repos": {
    /** List GitHub repositories accessible via the configured PAT. */
    $get: Endpoint<{ query?: GithubReposQuery }, GithubRepoInfo[]>;
  };
  "/system/models": {
    /** List available models. Proxies to `provider.list_models`; default lookup uses persistent hosts only. */
    $get: Endpoint<{ query?: SystemModelsQuery }, AvailableModel[]>;
  };
  "/system/providers": {
    /** List available providers. Proxies to `provider.list`; default lookup uses persistent hosts only. */
    $get: Endpoint<{ query?: SystemProvidersQuery }, SystemProviderInfo[]>;
  };
  "/system/voice-transcription": {
    /** Transcribe audio to text. Accepts audio file and optional prompt context. */
    $post: Endpoint<
      { form: SystemVoiceTranscriptionForm },
      SystemVoiceTranscriptionResponse
    >;
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
