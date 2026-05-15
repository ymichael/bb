import type { Hono } from "hono";
import { hc } from "hono/client";
import type {
  Environment,
  Host,
  PendingInteraction,
  ProjectExecutionDefaults,
  ResolvedThreadExecutionOptions,
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
  DeleteThreadRequest,
  EnvironmentDiffQuery,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusQuery,
  EnvironmentStatusResponse,
  ThreadStorageContentQuery,
  ThreadHostFileContentQuery,
  ThreadStorageFilesQuery,
  ProjectAttachmentContentQuery,
  ProjectBranchesQuery,
  ProjectBranchesResponse,
  ProjectDefaultExecutionOptionsQuery,
  ProjectAttachmentUploadForm,
  ProjectFilesQuery,
  ProjectListQuery,
  PromptHistoryQuery,
  PromptHistoryResponse,
  ProjectResponse,
  ProjectWithThreadsResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendMessageRequest,
  ResolvePendingInteractionRequest,
  ThreadAssignedChildSummaryResponse,
  ThreadComposerBootstrapResponse,
  ThreadDraftListResponse,
  GithubRepoInfo,
  GithubReposQuery,
  SandboxEnvVar,
  SandboxEnvVarName,
  SandboxEnvVarsResponse,
  SystemConfigResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemSandboxBackendInfo,
  SystemProviderInfo,
  SystemProvidersQuery,
  SystemVoiceTranscriptionForm,
  SystemVoiceTranscriptionResponse,
  ThreadEventWaitQuery,
  ThreadEventsQuery,
  ThreadGetQuery,
  ThreadListQuery,
  ThreadListResponse,
  ThreadPendingInteractionsResponse,
  ThreadResponse,
  ThreadWithIncludesResponse,
  ThreadTimelineQuery,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsQuery,
  TimelineTurnSummaryDetailsResponse,
  UpdateAutomationRequest,
  UpdateEnvironmentRequest,
  UpdateHostRequest,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UpdateThreadRequest,
  UpsertSandboxEnvVarRequest,
  UploadedPromptAttachment,
  ThreadStorageFileListResponse,
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
    $get: Endpoint<
      { query?: ProjectListQuery },
      ProjectResponse[] | ProjectWithThreadsResponse[]
    >;
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
  "/projects/:id/prompt-history": {
    $get: Endpoint<
      PathProjectId & { query?: PromptHistoryQuery },
      PromptHistoryResponse
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
     * Proxies to `host.list_files` against the path of the environment
     * identified by `environmentId` (e.g. a worktree) when provided, falling
     * back to the project's default source path when `environmentId` is null.
     */
    $get: Endpoint<
      PathProjectId & { query: ProjectFilesQuery },
      WorkspaceFileListResponse
    >;
  };
  "/projects/:id/branches": {
    /**
     * List branches available on the project's local-path source for the
     * given host. Used to populate the new-thread branch picker before any
     * environment exists. Dispatches `host.list_branches` against the
     * source's path — no provisioning, no env created.
     */
    $get: Endpoint<
      PathProjectId & { query: ProjectBranchesQuery },
      ProjectBranchesResponse
    >;
  };
  "/projects/:id/github-branches": {
    /**
     * List branches for the project's GitHub source via the GitHub API. Used
     * to populate the new-thread branch picker when the user picks a sandbox
     * environment that will clone the GitHub repo. Returns `current` set to
     * the repo's default branch so the picker can pre-select it.
     */
    $get: Endpoint<PathProjectId, ProjectBranchesResponse>;
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
      ThreadResponse,
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
  "/hosts/:id/join": {
    /** Cancels pending join material and deletes the host row only when the host has never opened a session. */
    $delete: Endpoint<PathId, { ok: true }>;
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
  "/environments/:id/diff": {
    /** Get git diff for an environment's workspace. Proxies to `workspace.diff`. */
    $get: Endpoint<
      PathId & { query: EnvironmentDiffQuery },
      ThreadGitDiffResponse
    >;
  };
  "/environments/:id/diff/file": {
    /**
     * Read a single file's contents at one side of the same diff target.
     * Used to feed `<FileDiff>`'s `oldFile`/`newFile` props so the diff
     * renderer can light up its built-in expand-context buttons.
     * Proxies to `host.read_file` (with `ref` for committed sides, omitted
     * for the working tree).
     */
    $get: Endpoint<
      PathId & { query: EnvironmentDiffFileQuery },
      EnvironmentDiffFileResponse
    >;
  };
  "/environments/:id/diff/branches": {
    /** List git branches. Proxies to `host.list_branches` against the environment's path. */
    $get: Endpoint<PathId, string[]>;
  };
  "/environments/:id/actions": {
    /**
     * Execute an environment action (commit, squash_merge).
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
    /**
     * List threads. Supports filters: projectId, type, parentThreadId, archived.
     * Omitting archived intentionally returns both active and archived threads.
     */
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
    $post: Endpoint<{ json: CreateThreadRequest }, ThreadResponse, 201>;
  };
  "/threads/:id": {
    $get: Endpoint<
      PathId & { query?: ThreadGetQuery },
      ThreadResponse | ThreadWithIncludesResponse
    >;
    /** Update thread metadata. If the title changes, also notifies providers that support `thread.rename`. */
    $patch: Endpoint<PathId & { json: UpdateThreadRequest }, ThreadResponse>;
    /**
     * Delete a thread. Also destroys its environment if one exists. Manager
     * threads with assigned child threads require explicit confirmation.
     */
    $delete: Endpoint<PathId & { json: DeleteThreadRequest }, { ok: true }>;
  };
  "/threads/:id/assigned-child-summary": {
    /** Count non-deleted threads assigned to a manager thread via parentThreadId. Archived child threads are included. */
    $get: Endpoint<PathId, ThreadAssignedChildSummaryResponse>;
  };
  "/threads/:id/send": {
    /**
     * Send a message to a thread.
     * Idle thread → starts a new turn. Active thread with mode=steer → steers the current turn.
     * senderThreadId marks immediate agent-to-agent CLI messages so the server can add reply guidance.
     * Draft routes intentionally omit it because drafts are stored queued messages,
     * not immediate sends from a live sender thread.
     */
    $post: Endpoint<PathId & { json: SendMessageRequest }, { ok: true }>;
  };
  "/threads/:id/composer-bootstrap": {
    /** Load initial composer state and prime the canonical composer query caches. */
    $get: Endpoint<PathId, ThreadComposerBootstrapResponse>;
  };
  "/threads/:id/drafts": {
    $get: Endpoint<PathId, ThreadDraftListResponse>;
    /** Create a queued draft. Use /threads/:id/send for immediate agent-to-agent messages. */
    $post: Endpoint<
      PathId & { json: CreateDraftRequest },
      ThreadQueuedMessage,
      201
    >;
  };
  "/threads/:id/drafts/:draftId/send": {
    /** Send a previously created queued draft in the requested mode, then delete the draft. */
    $post: Endpoint<
      PathThreadAndDraft & { json: SendDraftRequest },
      SendDraftResponse
    >;
  };
  "/threads/:id/prompt-history": {
    $get: Endpoint<
      PathId & { query?: PromptHistoryQuery },
      PromptHistoryResponse
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
     * checks workspace status for uncommitted or unmerged changes. Manager
     * threads with assigned child threads require explicit confirmation
     * separate from workspace force.
     * Stops the thread if active. If its managed environment now has zero
     * non-archived threads, destroys the environment.
     */
    $post: Endpoint<PathId & { json: ArchiveThreadRequest }, { ok: true }>;
  };
  "/threads/:id/unarchive": {
    $post: Endpoint<PathId, { ok: true }>;
  };
  "/threads/:id/read": {
    $post: Endpoint<PathId, ThreadResponse>;
  };
  "/threads/:id/unread": {
    $post: Endpoint<PathId, ThreadResponse>;
  };
  "/threads/:id/timeline": {
    /** Get thread timeline for UI rendering. Events transformed via `@bb/thread-view`. */
    $get: Endpoint<
      PathId & { query?: ThreadTimelineQuery },
      ThreadTimelineResponse
    >;
  };
  "/threads/:id/timeline/turn-summary-details": {
    /** Get nested turn-summary rows for a turn. Used by the UI to lazy-load expanded timeline detail. */
    $get: Endpoint<
      PathId & { query: TimelineTurnSummaryDetailsQuery },
      TimelineTurnSummaryDetailsResponse
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
      ThreadStorageFileListResponse
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
  "/threads/:id/host-files/content": {
    /**
     * Serve one explicit absolute file path from the thread environment host
     * as raw bytes with `Content-Type`. Proxies to rootless `host.read_file`.
     */
    $get: Endpoint<
      PathId & { query: ThreadHostFileContentQuery },
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
  "/system/execution-options": {
    /** List provider metadata and models for execution controls in one host lookup flow. */
    $get: Endpoint<
      { query?: SystemExecutionOptionsQuery },
      SystemExecutionOptionsResponse
    >;
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

/** Omit the options object to use global fetch; provide it to override fetch. */
export interface PublicApiClientOptions {
  fetch: typeof fetch;
}

export function createPublicApiClient(
  baseUrl: string,
  options?: PublicApiClientOptions,
) {
  return hc<PublicApiRoutes>(`${baseUrl}/api/v1`, options);
}

export function createApiClient(
  baseUrl: string,
  options?: PublicApiClientOptions,
) {
  const apiClient = createPublicApiClient(baseUrl, options);
  return {
    api: {
      v1: apiClient,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
