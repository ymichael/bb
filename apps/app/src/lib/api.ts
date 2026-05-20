import { extractErrorMessage, toRecord } from "@bb/core-ui";
import type {
  Environment,
  Host,
  PendingInteraction,
  Project,
  ProjectSource,
  ResolvedThreadExecutionOptions,
  ThreadType,
  ThreadGitDiffResponse,
  ThreadQueuedMessage,
  WorkspaceDiffTarget,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  CreateManagerThreadRequest,
  CreateHostJoinResponse,
  CreateProjectSourceRequest,
  CreateProjectRequest,
  CreateQueuedMessageRequest,
  DeleteThreadRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentStatusResponse,
  CreateThreadRequest,
  CreateThreadTerminalRequest,
  ProjectBranchesResponse,
  ProjectResponse,
  ProjectWithThreadsResponse,
  PromptHistoryResponse,
  SendQueuedMessageRequest,
  SendQueuedMessageResponse,
  SendMessageRequest,
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemVersionResponse,
  ManagerTimelineView,
  TimelinePaginationCursor,
  SystemVoiceTranscriptionResponse,
  ThreadAssignedChildSummaryResponse,
  ThreadComposerBootstrapResponse,
  ThreadPendingInteractionsResponse,
  ThreadQueuedMessageListResponse,
  ThreadListResponse,
  ThreadResponse,
  ThreadStatusVersionResponse,
  ThreadWithIncludesResponse,
  PathListIncludeQueryValue,
  ThreadStorageFilesQuery,
  ThreadStoragePathsQuery,
  TerminalSession,
  ThreadTerminalListResponse,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsRequest,
  TimelineTurnSummaryDetailsResponse,
  CloseThreadTerminalRequest,
  ResolvePendingInteractionRequest,
  UpdateEnvironmentRequest,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UpdateThreadTerminalRequest,
  UpdateProjectSourceRequest,
  UploadedPromptAttachment,
  ThreadStorageFileListResponse,
  ThreadStoragePathListResponse,
  WorkspaceFileListResponse,
  WorkspacePathListResponse,
  ReplayCaptureListResponse,
  ReplayRunRequest,
  ReplayRunResponse,
} from "@bb/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type EnvironmentFilePreviewSource,
  type FilePreview,
  type FilePreviewTarget,
} from "./file-preview";
import {
  buildThreadHostFileContentUrl,
  buildThreadStorageContentUrl,
} from "./file-content-urls";
import type { ThreadStorageFileListOptions } from "./thread-storage-files";
import type { PathListOptions } from "./path-list-options";
export type { FilePreview } from "./file-preview";

interface GetThreadTimelineArgs {
  beforeCursor?: TimelinePaginationCursor;
  id: string;
  includeNestedRows?: boolean;
  managerTimelineView?: ManagerTimelineView;
  segmentLimit?: number;
}

interface GetThreadTimelineTurnSummaryDetailsArgs extends TimelineTurnSummaryDetailsRequest {
  id: string;
}

interface GetEnvironmentFilePreviewArgs {
  id: string;
  path: string;
  source: EnvironmentFilePreviewSource;
  signal?: AbortSignal;
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

function decodeBase64Bytes(content: string): Uint8Array {
  const binaryContent = atob(content);
  const bytes = new Uint8Array(binaryContent.length);
  for (let index = 0; index < binaryContent.length; index += 1) {
    bytes[index] = binaryContent.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const binaryChunks: string[] = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binaryChunks.push(
      String.fromCharCode(...bytes.subarray(index, index + chunkSize)),
    );
  }
  return btoa(binaryChunks.join(""));
}

function decodeEnvironmentDiffFileContent(
  response: EnvironmentDiffFileResponse,
): Uint8Array {
  if (response.contentEncoding === "base64") {
    return decodeBase64Bytes(response.content);
  }

  return new TextEncoder().encode(response.content);
}

function buildEnvironmentDiffFilePreviewUrl(
  response: EnvironmentDiffFileResponse,
  contentBytes: Uint8Array,
  mimeType: string,
): string {
  const base64Content =
    response.contentEncoding === "base64"
      ? response.content
      : encodeBase64Bytes(contentBytes);
  return `data:${mimeType};base64,${base64Content}`;
}

interface BuildEnvironmentFilePreviewQueryArgs {
  path: string;
  source: EnvironmentFilePreviewSource;
}

function buildEnvironmentFilePreviewQuery({
  path,
  source,
}: BuildEnvironmentFilePreviewQueryArgs): EnvironmentDiffFileQuery {
  switch (source.kind) {
    case "working-tree":
      return {
        target: "uncommitted",
        path,
        side: "new",
      };
    case "head":
      return {
        target: "uncommitted",
        path,
        side: "old",
      };
    case "merge-base":
      return {
        target: "branch_committed",
        mergeBaseRef: source.ref,
        path,
        side: "old",
      };
  }
}

/**
 * The app previews workspace files by using the diff-file route. Current files
 * read the uncommitted new side from disk; deleted-file previews read the old
 * side from HEAD or the merge base because the working-tree path is gone.
 */
export async function getEnvironmentFilePreview({
  id,
  path,
  source,
  signal,
}: GetEnvironmentFilePreviewArgs): Promise<FilePreview> {
  const query = buildEnvironmentFilePreviewQuery({ path, source });
  const response = await request<EnvironmentDiffFileResponse>(
    apiClient.environments[":id"].diff.file.$get(
      {
        param: { id },
        query,
      },
      requestOptions(signal),
    ),
  );
  const contentBytes = decodeEnvironmentDiffFileContent(response);
  const mimeType = normalizeFilePreviewMimeType(response.mimeType ?? null);
  return buildFilePreview({
    contentBytes,
    mimeType,
    name: path.split("/").at(-1),
    path,
    url: buildEnvironmentDiffFilePreviewUrl(response, contentBytes, mimeType),
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

export async function listProjectsWithThreads(
  signal?: AbortSignal,
): Promise<ProjectWithThreadsResponse[]> {
  return request<ProjectWithThreadsResponse[]>(
    apiClient.projects.$get(
      {
        query: { include: "threads" },
      },
      requestOptions(signal),
    ),
  );
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

interface SearchProjectFilesArgs {
  projectId: string;
  query: string;
  limit: number;
  environmentId: string | null;
}

interface SearchProjectPathsArgs extends SearchProjectFilesArgs {
  includeFiles: boolean;
  includeDirectories: boolean;
}

export async function searchProjectFiles(
  args: SearchProjectFilesArgs,
): Promise<WorkspaceFileListResponse> {
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

function toPathListIncludeQueryValue(
  value: boolean,
): PathListIncludeQueryValue {
  return value ? "true" : "false";
}

export async function searchProjectPaths(
  args: SearchProjectPathsArgs,
): Promise<WorkspacePathListResponse> {
  return request<WorkspacePathListResponse>(
    apiClient.projects[":id"].paths.$get({
      param: { id: args.projectId },
      query: {
        query: args.query,
        limit: String(args.limit),
        environmentId: args.environmentId ?? "",
        includeFiles: toPathListIncludeQueryValue(args.includeFiles),
        includeDirectories: toPathListIncludeQueryValue(
          args.includeDirectories,
        ),
      },
    }),
  );
}

export async function getProjectSourceBranches(
  projectId: string,
  hostId: string,
): Promise<ProjectBranchesResponse> {
  return request<ProjectBranchesResponse>(
    apiClient.projects[":id"].branches.$get({
      param: { id: projectId },
      query: { hostId },
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
  /** When set, restrict to managed (true) or unmanaged (false) threads. */
  managed?: boolean;
  limit?: number;
  offset?: number;
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
          ...(filters.managed !== undefined
            ? { managed: toBooleanQueryValue(filters.managed) }
            : {}),
          ...(filters.limit !== undefined
            ? { limit: String(filters.limit) }
            : {}),
          ...(filters.offset !== undefined
            ? { offset: String(filters.offset) }
            : {}),
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

export async function getThreadWithEnvironmentHost(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadWithIncludesResponse> {
  return request<ThreadWithIncludesResponse>(
    apiClient.threads[":id"].$get(
      {
        param: { id },
        query: { include: "environment,host" },
      },
      requestOptions(signal),
    ),
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

interface ListThreadStorageFilesArgs {
  id: string;
  options: ThreadStorageFileListOptions;
  signal?: AbortSignal;
}

function toThreadStorageFilesQuery(
  options: ThreadStorageFileListOptions,
): ThreadStorageFilesQuery {
  const trimmedQuery = options.query?.trim() ?? "";
  return {
    ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
    limit: String(options.limit),
  };
}

export async function listThreadStorageFiles({
  id,
  options,
  signal,
}: ListThreadStorageFilesArgs): Promise<ThreadStorageFileListResponse> {
  return request<ThreadStorageFileListResponse>(
    apiClient.threads[":id"]["thread-storage"].files.$get(
      {
        param: { id },
        query: toThreadStorageFilesQuery(options),
      },
      requestOptions(signal),
    ),
  );
}

interface ListThreadStoragePathsArgs {
  id: string;
  options: PathListOptions;
  signal?: AbortSignal;
}

function toThreadStoragePathsQuery(
  options: PathListOptions,
): ThreadStoragePathsQuery {
  const trimmedQuery = options.query?.trim() ?? "";
  return {
    ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
    limit: String(options.limit),
    includeFiles: toPathListIncludeQueryValue(options.includeFiles),
    includeDirectories: toPathListIncludeQueryValue(options.includeDirectories),
  };
}

export async function listThreadStoragePaths({
  id,
  options,
  signal,
}: ListThreadStoragePathsArgs): Promise<ThreadStoragePathListResponse> {
  return request<ThreadStoragePathListResponse>(
    apiClient.threads[":id"]["thread-storage"].paths.$get(
      {
        param: { id },
        query: toThreadStoragePathsQuery(options),
      },
      requestOptions(signal),
    ),
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

export async function getThreadStatusVersion(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadStatusVersionResponse> {
  return request<ThreadStatusVersionResponse>(
    apiClient.threads[":id"]["status-version"].$get(
      { param: { id } },
      requestOptions(signal),
    ),
  );
}

export async function getThreadHostFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      name: path.split("/").at(-1),
      path,
      url: buildThreadHostFileContentUrl(id, path),
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

export async function listThreadTerminals(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadTerminalListResponse> {
  return request<ThreadTerminalListResponse>(
    apiClient.threads[":id"].terminals.$get(
      { param: { id } },
      requestOptions(signal),
    ),
  );
}

export async function createThreadTerminal(
  id: string,
  req: CreateThreadTerminalRequest,
): Promise<TerminalSession> {
  return request<TerminalSession>(
    apiClient.threads[":id"].terminals.$post({
      param: { id },
      json: req,
    }),
  );
}

export async function renameThreadTerminal(
  id: string,
  terminalId: string,
  req: UpdateThreadTerminalRequest,
): Promise<TerminalSession> {
  return request<TerminalSession>(
    apiClient.threads[":id"].terminals[":terminalId"].$patch({
      param: { id, terminalId },
      json: req,
    }),
  );
}

export async function closeThreadTerminal(
  id: string,
  terminalId: string,
  req: CloseThreadTerminalRequest,
): Promise<TerminalSession> {
  return request<TerminalSession>(
    apiClient.threads[":id"].terminals[":terminalId"].close.$post({
      param: { id, terminalId },
      json: req,
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

export async function createThreadQueuedMessage(
  id: string,
  req: CreateQueuedMessageRequest,
): Promise<ThreadQueuedMessage> {
  return request<ThreadQueuedMessage>(
    apiClient.threads[":id"]["queued-messages"].$post({
      param: { id },
      json: req,
    }),
  );
}

export async function getThreadComposerBootstrap(
  id: string,
): Promise<ThreadComposerBootstrapResponse> {
  return request<ThreadComposerBootstrapResponse>(
    apiClient.threads[":id"]["composer-bootstrap"].$get({ param: { id } }),
  );
}

export async function listThreadQueuedMessages(
  id: string,
): Promise<ThreadQueuedMessageListResponse> {
  return request<ThreadQueuedMessageListResponse>(
    apiClient.threads[":id"]["queued-messages"].$get({ param: { id } }),
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

export async function sendThreadQueuedMessage(
  id: string,
  queuedMessageId: string,
  req: SendQueuedMessageRequest,
): Promise<SendQueuedMessageResponse> {
  return request<SendQueuedMessageResponse>(
    apiClient.threads[":id"]["queued-messages"][":queuedMessageId"].send.$post({
      param: { id, queuedMessageId },
      json: req,
    }),
  );
}

export async function deleteThreadQueuedMessage(
  id: string,
  queuedMessageId: string,
): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"]["queued-messages"][":queuedMessageId"].$delete({
      param: { id, queuedMessageId },
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

export async function archiveThread(id: string): Promise<void> {
  await requestVoid(
    apiClient.threads[":id"].archive.$post({
      param: { id },
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

export async function getEnvironment(
  id: string,
  signal?: AbortSignal,
): Promise<Environment> {
  return request<Environment>(
    apiClient.environments[":id"].$get(
      { param: { id } },
      requestOptions(signal),
    ),
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
  signal?: AbortSignal,
): Promise<WorkspaceStatus | null> {
  const res = await request<EnvironmentStatusResponse>(
    apiClient.environments[":id"].status.$get(
      {
        param: { id: environmentId },
        query: mergeBaseBranch ? { mergeBaseBranch } : {},
      },
      requestOptions(signal),
    ),
  );
  return res.workspace;
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

export async function getThreadTimeline({
  beforeCursor,
  id,
  includeNestedRows = false,
  managerTimelineView,
  segmentLimit,
}: GetThreadTimelineArgs): Promise<ThreadTimelineResponse> {
  return request<ThreadTimelineResponse>(
    apiClient.threads[":id"].timeline.$get({
      param: { id },
      query: {
        ...(includeNestedRows ? { includeNestedRows: "true" } : {}),
        ...(managerTimelineView ? { managerTimelineView } : {}),
        ...(segmentLimit !== undefined
          ? { segmentLimit: String(segmentLimit) }
          : {}),
        ...(beforeCursor
          ? {
              beforeAnchorSeq: String(beforeCursor.anchorSeq),
              beforeAnchorId: beforeCursor.anchorId,
            }
          : {}),
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

export type DiffFileSide = "old" | "new";

/**
 * File-fetch target for {@link getEnvironmentDiffFile}. Differs from
 * `WorkspaceDiffTarget` for `branch_committed` / `all`: instead of the merge
 * base *branch name*, the caller must pass the resolved merge-base SHA that
 * `workspace.diff` returned (via `ThreadGitDiffResponse.mergeBaseRef`). That
 * keeps the per-file read aligned with the exact ref the diff was computed
 * against — the branch tip can drift past the merge base between the diff
 * load and the file read, breaking `@pierre/diffs`' context expansion.
 */
export type DiffFileTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed"; mergeBaseRef: string }
  | { type: "all"; mergeBaseRef: string }
  | { type: "commit"; sha: string };

export async function getEnvironmentDiffFile(
  id: string,
  target: DiffFileTarget,
  path: string,
  side: DiffFileSide,
): Promise<EnvironmentDiffFileResponse> {
  const baseQuery = (() => {
    switch (target.type) {
      case "uncommitted":
        return { target: "uncommitted" as const };
      case "branch_committed":
        return {
          target: "branch_committed" as const,
          mergeBaseRef: target.mergeBaseRef,
        };
      case "all":
        return {
          target: "all" as const,
          mergeBaseRef: target.mergeBaseRef,
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

  return request<EnvironmentDiffFileResponse>(
    apiClient.environments[":id"].diff.file.$get({
      param: { id },
      query: { ...baseQuery, path, side },
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

export async function getSystemExecutionOptions(args: {
  environmentId?: string;
  providerId?: string;
}): Promise<SystemExecutionOptionsResponse> {
  return request<SystemExecutionOptionsResponse>(
    apiClient.system["execution-options"].$get({
      query: {
        ...(args.environmentId ? { environmentId: args.environmentId } : {}),
        ...(args.providerId ? { providerId: args.providerId } : {}),
      },
    }),
  );
}

export async function listSystemProviders(): Promise<SystemProviderInfo[]> {
  return request<SystemProviderInfo[]>(
    apiClient.system.providers.$get({ query: {} }),
  );
}

export async function getSystemVersion(): Promise<SystemVersionResponse> {
  return request<SystemVersionResponse>(apiClient.system.version.$get());
}

export async function listHosts(): Promise<Host[]> {
  return request<Host[]>(apiClient.hosts.$get());
}

export async function createHostJoin(): Promise<CreateHostJoinResponse> {
  return request<CreateHostJoinResponse>(
    apiClient.hosts.join.$post({
      json: {
        hostType: "persistent",
      },
    }),
  );
}

export async function cancelHostJoin(id: string): Promise<void> {
  await requestVoid(apiClient.hosts[":id"].join.$delete({ param: { id } }));
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
