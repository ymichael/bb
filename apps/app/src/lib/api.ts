import { extractErrorMessage, toRecord } from "@bb/core-ui";
import type { CloudAuthProviderId } from "@bb/agent-providers";
import type {
  AvailableModel,
  Environment,
  Host,
  PendingInteraction,
  Project,
  ProjectSource,
  ResolvedThreadExecutionOptions,
  SandboxBackendInfo,
  ThreadType,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  WorkspaceDiffTarget,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  ArchiveThreadRequest,
  CreateManagerThreadRequest,
  CloudAuthAttemptResponse,
  CloudAuthConnectResponse,
  CloudAuthSettingsResponse,
  GithubRepoInfo,
  CreateProjectSourceRequest,
  CreateProjectRequest,
  CreateDraftRequest,
  DeleteThreadRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentPromotionResponse,
  EnvironmentStatusResponse,
  CreateThreadRequest,
  ProjectResponse,
  ProjectSourceWorkspaceStatusResponse,
  PromptHistoryResponse,
  SendDraftResponse,
  SendMessageRequest,
  SystemProviderInfo,
  ManagerTimelineView,
  SandboxEnvVar,
  SandboxEnvVarsResponse,
  SystemVoiceTranscriptionResponse,
  ThreadAssignedChildSummaryResponse,
  ThreadPendingInteractionsResponse,
  ThreadDraftListResponse,
  ThreadListResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsRequest,
  TimelineTurnSummaryDetailsResponse,
  ResolvePendingInteractionRequest,
  UpdateEnvironmentRequest,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UpdateProjectSourceRequest,
  UploadedPromptAttachment,
  UpsertSandboxEnvVarRequest,
  WorkspaceFileListResponse,
  ReplayCaptureListResponse,
  ReplayRunRequest,
  ReplayRunResponse,
} from "@bb/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type FilePreview,
  type FilePreviewTarget,
} from "./file-preview";
import { buildThreadStorageContentUrl } from "./file-content-urls";
export type { FilePreview } from "./file-preview";

interface GetThreadTimelineTurnSummaryDetailsArgs extends TimelineTurnSummaryDetailsRequest {
  id: string;
}
export type AppCreateManagerThreadRequest = Omit<
  CreateManagerThreadRequest,
  "origin"
>;
export type AppCreateThreadRequest = Omit<CreateThreadRequest, "origin">;

const MAX_ERROR_MESSAGE_LENGTH = 180;
const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;
const ERROR_EXTRACT_OPTS = {
  maxLength: MAX_ERROR_MESSAGE_LENGTH,
  legacyKeys: ["detail"] as const,
};

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function requestOptions(signal?: AbortSignal) {
  return signal ? { init: { signal } } : undefined;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    body?: unknown;
  }) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "HttpError";
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
  }
}

function deriveHttpErrorMessage(
  status: number,
  statusText: string,
  rawBody: string,
  contentType: string | null,
): string {
  const normalized = normalizeErrorText(rawBody);
  if (normalized.length === 0) {
    return statusText || "Request failed";
  }

  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (shouldParseAsJson) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      const message = extractErrorMessage(parsed, ERROR_EXTRACT_OPTS);
      if (message) {
        return message;
      }
    } catch {
      // Fall through to non-JSON handling.
    }
  }

  if (HTML_DOCUMENT_PATTERN.test(normalized)) {
    if (status === 401 || status === 403) {
      return "Authentication failed";
    }
    return statusText || "Request failed";
  }

  return (
    (extractErrorMessage(normalized, ERROR_EXTRACT_OPTS) ?? statusText) ||
    "Request failed"
  );
}

function parseHttpErrorBody(
  rawBody: string,
  contentType: string | null,
): unknown | undefined {
  const normalized = normalizeErrorText(rawBody);
  if (normalized.length === 0) {
    return undefined;
  }

  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (!shouldParseAsJson) {
    return undefined;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}

function extractErrorCode(value: unknown): string | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record.code === "string" && record.code.trim().length > 0
    ? record.code
    : undefined;
}

async function throwHttpError(res: Response): Promise<never> {
  const rawBody = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type");
  const message = deriveHttpErrorMessage(
    res.status,
    res.statusText,
    rawBody,
    contentType,
  );
  const body = parseHttpErrorBody(rawBody, contentType);
  throw new HttpError({
    status: res.status,
    message,
    code: extractErrorCode(body),
    body,
  });
}

async function request<T>(responsePromise: Promise<Response>): Promise<T> {
  const res = await requestResponse(responsePromise);
  const text = await res.text();
  return JSON.parse(text) as T;
}

async function requestVoid(responsePromise: Promise<Response>): Promise<void> {
  await requestResponse(responsePromise);
}

async function requestResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const res = await responsePromise;
  if (!res.ok) {
    await throwHttpError(res);
  }
  return res;
}

export async function loadFilePreview(
  target: FilePreviewTarget,
  signal?: AbortSignal,
): Promise<FilePreview> {
  const response = await requestResponse(
    fetch(target.url, {
      method: "GET",
      signal,
    }),
  );
  const contentBytes = new Uint8Array(await response.arrayBuffer());
  return buildFilePreview({
    contentBytes,
    mimeType: normalizeFilePreviewMimeType(
      response.headers.get("content-type"),
    ),
    name: target.name,
    path: target.path,
    url: target.url,
  });
}

async function postMultipart<T>(
  url: URL,
  file: File,
  signal?: AbortSignal,
  fields?: Record<string, string>,
): Promise<T> {
  const formData = new FormData();
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }
  }
  formData.set("file", file, file.name);

  const res = await fetch(toRelativeUrl(url), {
    method: "POST",
    body: formData,
    signal,
  });
  if (!res.ok) {
    await throwHttpError(res);
  }
  const text = await res.text();
  return JSON.parse(text) as T;
}

export async function listReplayCaptures(): Promise<ReplayCaptureListResponse> {
  return request<ReplayCaptureListResponse>(
    apiClient["development-only"].replay.captures.$get(),
  );
}

export async function startReplayRun(
  id: string,
  req: ReplayRunRequest,
): Promise<ReplayRunResponse> {
  return request<ReplayRunResponse>(
    apiClient["development-only"].replay.captures[":id"].runs.$post({
      param: { id },
      json: req,
    }),
  );
}

export async function deleteReplayCapture(id: string): Promise<void> {
  await requestVoid(
    apiClient["development-only"].replay.captures[":id"].$delete({
      param: { id },
    }),
  );
}

export async function createProject(
  req: CreateProjectRequest,
): Promise<Project> {
  return request<Project>(apiClient.projects.$post({ json: req }));
}

export async function hireProjectManager(
  projectId: string,
  options: AppCreateManagerThreadRequest,
): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.projects[":id"].managers.$post({
      param: { id: projectId },
      json: {
        ...options,
        origin: "app",
      },
    }),
  );
}

export async function updateProject(
  id: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  return request<Project>(
    apiClient.projects[":id"].$patch({ param: { id }, json: req }),
  );
}

export async function listProjects(): Promise<ProjectResponse[]> {
  return request<ProjectResponse[]>(apiClient.projects.$get());
}

export async function listProjectPromptHistory(
  projectId: string,
  signal?: AbortSignal,
): Promise<PromptHistoryResponse> {
  return request<PromptHistoryResponse>(
    apiClient.projects[":id"]["prompt-history"].$get(
      { param: { id: projectId } },
      requestOptions(signal),
    ),
  );
}

export async function deleteProject(id: string): Promise<void> {
  await requestVoid(apiClient.projects[":id"].$delete({ param: { id } }));
}

export async function addProjectSource(
  projectId: string,
  req: CreateProjectSourceRequest,
): Promise<ProjectSource> {
  return request<ProjectSource>(
    apiClient.projects[":id"].sources.$post({
      param: { id: projectId },
      json: req,
    }),
  );
}

export async function updateProjectSource(
  projectId: string,
  sourceId: string,
  req: UpdateProjectSourceRequest,
): Promise<ProjectSource> {
  return request<ProjectSource>(
    apiClient.projects[":id"].sources[":sourceId"].$patch({
      param: { id: projectId, sourceId },
      json: req,
    }),
  );
}

export async function removeProjectSource(
  projectId: string,
  sourceId: string,
): Promise<void> {
  await requestVoid(
    apiClient.projects[":id"].sources[":sourceId"].$delete({
      param: { id: projectId, sourceId },
    }),
  );
}

export async function searchProjectFiles(args: {
  projectId: string;
  query: string;
  limit: number;
  environmentId: string | null;
}): Promise<WorkspaceFileListResponse> {
  return request<WorkspaceFileListResponse>(
    apiClient.projects[":id"].files.$get({
      param: { id: args.projectId },
      query: {
        query: args.query,
        limit: String(args.limit),
        environmentId: args.environmentId ?? "",
      },
    }),
  );
}

export async function getProjectSourceWorkspaceStatus(
  projectId: string,
  sourceId: string,
): Promise<ProjectSourceWorkspaceStatusResponse> {
  return request<ProjectSourceWorkspaceStatusResponse>(
    apiClient.projects[":id"].sources[":sourceId"].status.$get({
      param: { id: projectId, sourceId },
    }),
  );
}

export async function uploadPromptAttachment(
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  return postMultipart<UploadedPromptAttachment>(
    apiClient.projects[":id"].attachments.$url({ param: { id: projectId } }),
    file,
  );
}

export async function transcribeVoiceInput(
  file: File,
  prompt?: string,
  signal?: AbortSignal,
): Promise<SystemVoiceTranscriptionResponse> {
  const trimmedPrompt = prompt?.trim();
  return postMultipart<SystemVoiceTranscriptionResponse>(
    apiClient.system["voice-transcription"].$url(),
    file,
    signal,
    trimmedPrompt ? { prompt: trimmedPrompt } : undefined,
  );
}

export async function createThread(
  req: AppCreateThreadRequest,
): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.threads.$post({
      json: {
        ...req,
        origin: "app",
      },
    }),
  );
}

export interface ThreadListFilters {
  projectId: string;
  type?: ThreadType;
  parentThreadId?: string;
  /** App callers must choose active or archived; server omission intentionally means both. */
  archived: boolean;
}

function toBooleanQueryValue(value: boolean): "true" | "false" {
  return value ? "true" : "false";
}

export async function listThreads(
  filters: ThreadListFilters,
  signal?: AbortSignal,
): Promise<ThreadListResponse> {
  return request<ThreadListResponse>(
    apiClient.threads.$get(
      {
        query: {
          projectId: filters.projectId,
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.parentThreadId
            ? { parentThreadId: filters.parentThreadId }
            : {}),
          archived: toBooleanQueryValue(filters.archived),
        },
      },
      requestOptions(signal),
    ),
  );
}

export async function getThread(id: string): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.threads[":id"].$get({ param: { id } }),
  );
}

export async function getThreadAssignedChildSummary(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadAssignedChildSummaryResponse> {
  return request<ThreadAssignedChildSummaryResponse>(
    apiClient.threads[":id"]["assigned-child-summary"].$get(
      { param: { id } },
      requestOptions(signal),
    ),
  );
}

export async function listThreadStorageFiles(
  id: string,
): Promise<WorkspaceFileListResponse> {
  return request<WorkspaceFileListResponse>(
    apiClient.threads[":id"]["thread-storage"].files.$get({ param: { id } }),
  );
}

export async function getThreadStorageFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      path,
      url: buildThreadStorageContentUrl(id, path),
    },
    signal,
  );
}

export async function updateThread(
  id: string,
  req: UpdateThreadRequest,
): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.threads[":id"].$patch({ param: { id }, json: req }),
  );
}

export async function getThreadDefaultExecutionOptions(
  id: string,
): Promise<ResolvedThreadExecutionOptions | null> {
  return request<ResolvedThreadExecutionOptions | null>(
    apiClient.threads[":id"]["default-execution-options"].$get({
      param: { id },
    }),
  );
}

export async function sendThreadMessage(
  id: string,
  req: SendMessageRequest,
): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].send.$post({ param: { id }, json: req }),
  );
}

export async function createThreadDraft(
  id: string,
  req: CreateDraftRequest,
): Promise<ThreadQueuedMessage> {
  return request<ThreadQueuedMessage>(
    apiClient.threads[":id"].drafts.$post({ param: { id }, json: req }),
  );
}

export async function listThreadDrafts(
  id: string,
): Promise<ThreadDraftListResponse> {
  return request<ThreadDraftListResponse>(
    apiClient.threads[":id"].drafts.$get({ param: { id } }),
  );
}

export async function listThreadPromptHistory(
  id: string,
  signal?: AbortSignal,
): Promise<PromptHistoryResponse> {
  return request<PromptHistoryResponse>(
    apiClient.threads[":id"]["prompt-history"].$get(
      { param: { id } },
      requestOptions(signal),
    ),
  );
}

export async function sendThreadDraft(
  id: string,
  queuedMessageId: string,
): Promise<SendDraftResponse> {
  return request<SendDraftResponse>(
    apiClient.threads[":id"].drafts[":draftId"].send.$post({
      param: { id, draftId: queuedMessageId },
      json: {},
    }),
  );
}

export async function deleteThreadDraft(
  id: string,
  queuedMessageId: string,
): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].drafts[":draftId"].$delete({
      param: { id, draftId: queuedMessageId },
    }),
  );
}

export async function stopThread(id: string): Promise<void> {
  await requestVoid(apiClient.threads[":id"].stop.$post({ param: { id } }));
}

export async function listThreadPendingInteractions(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadPendingInteractionsResponse> {
  return request<ThreadPendingInteractionsResponse>(
    apiClient.threads[":id"].interactions.$get(
      { param: { id } },
      requestOptions(signal),
    ),
  );
}

export async function resolveThreadPendingInteraction(
  threadId: string,
  interactionId: string,
  req: ResolvePendingInteractionRequest,
): Promise<PendingInteraction> {
  return request<PendingInteraction>(
    apiClient.threads[":id"].interactions[":interactionId"].resolve.$post({
      param: { id: threadId, interactionId },
      json: req,
    }),
  );
}

export async function archiveThread(
  id: string,
  opts: ArchiveThreadRequest,
): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].archive.$post({
      param: { id },
      json: opts,
    }),
  );
}

export async function unarchiveThread(id: string): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].unarchive.$post({ param: { id } }),
  );
}

export async function deleteThread(
  id: string,
  opts: DeleteThreadRequest,
): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].$delete({ param: { id }, json: opts }),
  );
}

export async function markThreadRead(id: string): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.threads[":id"].read.$post({ param: { id } }),
  );
}

export async function markThreadUnread(id: string): Promise<ThreadResponse> {
  return request<ThreadResponse>(
    apiClient.threads[":id"].unread.$post({ param: { id } }),
  );
}

export async function getEnvironment(id: string): Promise<Environment> {
  return request<Environment>(
    apiClient.environments[":id"].$get({ param: { id } }),
  );
}

export async function updateEnvironment(
  id: string,
  req: UpdateEnvironmentRequest,
): Promise<Environment> {
  return request<Environment>(
    apiClient.environments[":id"].$patch({ param: { id }, json: req }),
  );
}

export async function getEnvironmentWorkStatus(
  environmentId: string,
  mergeBaseBranch?: string,
): Promise<WorkspaceStatus | null> {
  const res = await request<EnvironmentStatusResponse>(
    apiClient.environments[":id"].status.$get({
      param: { id: environmentId },
      query: mergeBaseBranch ? { mergeBaseBranch } : {},
    }),
  );
  return res.workspace;
}

export async function getEnvironmentPromotion(
  environmentId: string,
): Promise<EnvironmentPromotionResponse> {
  return request<EnvironmentPromotionResponse>(
    apiClient.environments[":id"].promotion.$get({
      param: { id: environmentId },
    }),
  );
}

export async function getEnvironmentDiffBranches(
  id: string,
): Promise<string[]> {
  return request<string[]>(
    apiClient.environments[":id"].diff.branches.$get({ param: { id } }),
  );
}

export async function requestEnvironmentAction(
  id: string,
  req: EnvironmentActionRequest,
): Promise<EnvironmentActionResponse> {
  return request<EnvironmentActionResponse>(
    apiClient.environments[":id"].actions.$post({ param: { id }, json: req }),
  );
}

export async function getThreadTimeline(
  id: string,
  includeNestedRows: boolean = false,
  managerTimelineView?: ManagerTimelineView,
): Promise<ThreadTimelineResponse> {
  return request<ThreadTimelineResponse>(
    apiClient.threads[":id"].timeline.$get({
      param: { id },
      query: {
        ...(includeNestedRows ? { includeNestedRows: "true" } : {}),
        ...(managerTimelineView ? { managerTimelineView } : {}),
      },
    }),
  );
}

export async function getThreadTimelineTurnSummaryDetails({
  id,
  turnId,
  sourceSeqStart,
  sourceSeqEnd,
  managerTimelineView,
}: GetThreadTimelineTurnSummaryDetailsArgs): Promise<TimelineTurnSummaryDetailsResponse> {
  return request<TimelineTurnSummaryDetailsResponse>(
    apiClient.threads[":id"].timeline["turn-summary-details"].$get({
      param: { id },
      query: {
        turnId,
        sourceSeqStart: String(sourceSeqStart),
        sourceSeqEnd: String(sourceSeqEnd),
        ...(managerTimelineView ? { managerTimelineView } : {}),
      },
    }),
  );
}

export async function getEnvironmentDiff(
  id: string,
  target: WorkspaceDiffTarget,
): Promise<ThreadGitDiffResponse> {
  const query = (() => {
    switch (target.type) {
      case "uncommitted":
        return { target: "uncommitted" as const };
      case "branch_committed":
        return {
          target: "branch_committed" as const,
          mergeBaseBranch: target.mergeBaseBranch,
        };
      case "all":
        return {
          target: "all" as const,
          mergeBaseBranch: target.mergeBaseBranch,
        };
      case "commit":
        return {
          target: "commit" as const,
          sha: target.sha,
        };
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  })();

  return request<ThreadGitDiffResponse>(
    apiClient.environments[":id"].diff.$get({
      param: { id },
      query,
    }),
  );
}

export async function getAvailableModels(
  providerId?: string,
  selectedModel?: string,
): Promise<AvailableModel[]> {
  return request<AvailableModel[]>(
    apiClient.system.models.$get({
      query: {
        ...(providerId ? { providerId } : {}),
        ...(selectedModel ? { selectedModel } : {}),
      },
    }),
  );
}

export async function listSystemProviders(): Promise<SystemProviderInfo[]> {
  return request<SystemProviderInfo[]>(
    apiClient.system.providers.$get({ query: {} }),
  );
}

export async function listHosts(): Promise<Host[]> {
  return request<Host[]>(apiClient.hosts.$get());
}

export async function getHost(id: string): Promise<Host> {
  return request<Host>(apiClient.hosts[":id"].$get({ param: { id } }));
}

export async function updateHost(
  id: string,
  req: { name: string },
): Promise<Host> {
  return request<Host>(
    apiClient.hosts[":id"].$patch({ param: { id }, json: req }),
  );
}

export async function deleteHost(id: string): Promise<void> {
  await requestVoid(apiClient.hosts[":id"].$delete({ param: { id } }));
}

export async function listSandboxBackends(): Promise<SandboxBackendInfo[]> {
  return request<SandboxBackendInfo[]>(
    apiClient.system["sandbox-backends"].$get(),
  );
}

export async function getCloudAuthSettings(): Promise<CloudAuthSettingsResponse> {
  return request<CloudAuthSettingsResponse>(
    apiClient.system["cloud-auth"].$get(),
  );
}

export async function startCloudAuthConnection(
  providerId: CloudAuthProviderId,
): Promise<CloudAuthConnectResponse> {
  return request<CloudAuthConnectResponse>(
    apiClient.system["cloud-auth"][":providerId"].connect.$post({
      param: { providerId },
      json: { appOrigin: window.location.origin },
    }),
  );
}

export async function getCloudAuthAttempt(
  attemptId: string,
): Promise<CloudAuthAttemptResponse> {
  return request<CloudAuthAttemptResponse>(
    apiClient.system["cloud-auth"].attempts[":attemptId"].$get({
      param: { attemptId },
    }),
  );
}

export async function deleteCloudAuthProvider(
  providerId: CloudAuthProviderId,
): Promise<void> {
  await requestVoid(
    apiClient.system["cloud-auth"][":providerId"].$delete({
      param: { providerId },
    }),
  );
}

export async function listSandboxEnvVars(): Promise<SandboxEnvVarsResponse> {
  return request<SandboxEnvVarsResponse>(
    apiClient.system["sandbox-env-vars"].$get(),
  );
}

export async function upsertSandboxEnvVar(
  requestBody: UpsertSandboxEnvVarRequest,
): Promise<SandboxEnvVar> {
  return request<SandboxEnvVar>(
    apiClient.system["sandbox-env-vars"].$post({
      json: requestBody,
    }),
  );
}

export async function deleteSandboxEnvVar(name: string): Promise<void> {
  await requestVoid(
    apiClient.system["sandbox-env-vars"][":name"].$delete({
      param: { name },
    }),
  );
}

export async function listGithubRepos(q?: string): Promise<GithubRepoInfo[]> {
  return request<GithubRepoInfo[]>(
    apiClient.system["github-repos"].$get({ query: q ? { q } : undefined }),
  );
}
