import {
  extractErrorMessage,
  toRecord,
} from "@bb/core-ui";
import type {
  Environment,
  Host,
  Project,
  ProjectSource,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadType,
  ThreadGitDiffResponse,
  ThreadGitDiffSelection,
  ThreadQueuedMessage,
  WorkspaceStatus,
  AvailableModel,
} from "@bb/domain";
import type {
  CreateManagerThreadRequest,
  CreateProjectSourceRequest,
  CreateProjectRequest,
  CreateDraftRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusResponse,
  ProjectFileSuggestion,
  SendDraftResponse,
  CreateThreadRequest,
  SystemProviderInfo,
  SystemVoiceTranscriptionResponse,
  SendMessageRequest,
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UpdateProjectSourceRequest,
  UploadedPromptAttachment,
  ProjectResponse,
} from "@bb/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";

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

  return (extractErrorMessage(normalized, ERROR_EXTRACT_OPTS) ?? statusText) || "Request failed";
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
  const res = await responsePromise;
  if (!res.ok) {
    await throwHttpError(res);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
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
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  return request<Project>(apiClient.projects.$post({ json: req }));
}

export async function hireProjectManager(
  projectId: string,
  options: CreateManagerThreadRequest,
): Promise<Thread> {
  return request<Thread>(
    apiClient.projects[":id"].managers.$post({
      param: { id: projectId },
      json: options,
    }),
  );
}

export async function updateProject(
  id: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  return request<Project>(apiClient.projects[":id"].$patch({ param: { id }, json: req }));
}

export async function listProjects(): Promise<ProjectResponse[]> {
  return request<ProjectResponse[]>(apiClient.projects.$get());
}

export async function deleteProject(id: string): Promise<void> {
  await request<unknown>(apiClient.projects[":id"].$delete({ param: { id } }));
}

export async function addProjectSource(
  projectId: string,
  req: CreateProjectSourceRequest,
): Promise<ProjectSource> {
  return request<ProjectSource>(
    apiClient.projects[":id"].sources.$post({ param: { id: projectId }, json: req }),
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
  await request<unknown>(
    apiClient.projects[":id"].sources[":sourceId"].$delete({
      param: { id: projectId, sourceId },
    }),
  );
}

export async function searchProjectFiles(
  projectId: string,
  query: string,
  limit: number = 8,
): Promise<ProjectFileSuggestion[]> {
  return request<ProjectFileSuggestion[]>(
    apiClient.projects[":id"].files.$get({
      param: { id: projectId },
      query: { query, limit: String(limit) },
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



export async function createThread(req: CreateThreadRequest): Promise<Thread> {
  return request<Thread>(apiClient.threads.$post({ json: req }));
}

export async function listThreads(
  filters?: {
    projectId?: string;
    type?: ThreadType;
    parentThreadId?: string;
    archived?: boolean;
  },
  signal?: AbortSignal,
): Promise<Thread[]> {
  return request<Thread[]>(
    apiClient.threads.$get({
      query: {
        ...(filters?.projectId ? { projectId: filters.projectId } : {}),
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.parentThreadId ? { parentThreadId: filters.parentThreadId } : {}),
        ...(filters?.archived !== undefined
          ? { archived: String(filters.archived) as "true" | "false" }
          : {}),
      },
    }, requestOptions(signal)),
  );
}

export async function getThread(id: string): Promise<Thread> {
  return request<Thread>(apiClient.threads[":id"].$get({ param: { id } }));
}

export interface ManagerWorkspaceFileEntry {
  path: string;
  size: number;
}

export async function listThreadManagerWorkspaceFiles(
  id: string,
): Promise<{ files: ManagerWorkspaceFileEntry[] }> {
  return request<{ files: ManagerWorkspaceFileEntry[] }>(
    apiClient.threads[":id"].workspace.files.$get({ param: { id } }),
  );
}

export async function getThreadManagerWorkspaceFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  return request<{ path: string; content: string }>(
    apiClient.threads[":id"].workspace.file.$get({
      param: { id },
      query: { path },
    }),
  );
}

export async function updateThread(
  id: string,
  req: UpdateThreadRequest,
): Promise<Thread> {
  return request<Thread>(apiClient.threads[":id"].$patch({ param: { id }, json: req }));
}

export async function getThreadDefaultExecutionOptions(
  id: string,
): Promise<ResolvedThreadExecutionOptions | null> {
  return request<ResolvedThreadExecutionOptions | null>(
    apiClient.threads[":id"]["default-execution-options"].$get({ param: { id } }),
  );
}

export async function sendThreadMessage(id: string, req: SendMessageRequest): Promise<void> {
  await request<unknown>(apiClient.threads[":id"].send.$post({ param: { id }, json: req }));
}

export async function createThreadDraft(
  id: string,
  req: CreateDraftRequest,
): Promise<ThreadQueuedMessage> {
  return request<ThreadQueuedMessage>(
    apiClient.threads[":id"].drafts.$post({ param: { id }, json: req }),
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
  await request<unknown>(
    apiClient.threads[":id"].drafts[":draftId"].$delete({
      param: { id, draftId: queuedMessageId },
    }),
  );
}

export async function stopThread(id: string): Promise<void> {
  await request<unknown>(apiClient.threads[":id"].stop.$post({ param: { id } }));
}

export async function archiveThread(
  id: string,
  opts: { force: boolean },
): Promise<void> {
  await request<unknown>(
    apiClient.threads[":id"].archive.$post({
      param: { id },
      json: { force: opts.force },
    }),
  );
}

export async function unarchiveThread(id: string): Promise<void> {
  await request<unknown>(apiClient.threads[":id"].unarchive.$post({ param: { id } }));
}

export async function deleteThread(id: string): Promise<void> {
  await request<unknown>(apiClient.threads[":id"].$delete({ param: { id } }));
}

export async function markThreadRead(id: string): Promise<Thread> {
  return request<Thread>(apiClient.threads[":id"].read.$post({ param: { id } }));
}

export async function markThreadUnread(id: string): Promise<Thread> {
  return request<Thread>(apiClient.threads[":id"].unread.$post({ param: { id } }));
}

export async function getEnvironment(id: string): Promise<Environment> {
  return request<Environment>(apiClient.environments[":id"].$get({ param: { id } }));
}

export async function getEnvironmentWorkStatus(
  environmentId: string,
  mergeBaseBranch: string,
): Promise<WorkspaceStatus | null> {
  const res = await request<EnvironmentStatusResponse>(
    apiClient.environments[":id"].status.$get({
      param: { id: environmentId },
      query: { mergeBaseBranch },
    }),
  );
  return res.workspace;
}

export async function getEnvironmentDiffBranches(id: string): Promise<string[]> {
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
  limit?: number,
  includeToolGroupMessages: boolean = false,
  includeManagerWorkspaceViewer: boolean = false,
): Promise<ThreadTimelineResponse> {
  return request<ThreadTimelineResponse>(
    apiClient.threads[":id"].timeline.$get({
      param: { id },
      query: {
        ...(limit !== undefined ? { limit: String(limit) } : {}),
        ...(includeToolGroupMessages ? { includeToolGroupMessages: "true" } : {}),
        ...(includeManagerWorkspaceViewer ? { includeManagerDebugView: "true" } : {}),
      },
    }),
  );
}

export async function getThreadTimelineToolDetails(
  id: string,
  turnId: string,
  sourceSeqStart: number,
  sourceSeqEnd: number,
  includeManagerWorkspaceViewer: boolean = false,
): Promise<TimelineToolDetailsResponse> {
  return request<TimelineToolDetailsResponse>(
    apiClient.threads[":id"].timeline["tool-details"].$get({
      param: { id },
      query: {
        turnId,
        sourceSeqStart: String(sourceSeqStart),
        sourceSeqEnd: String(sourceSeqEnd),
        ...(includeManagerWorkspaceViewer ? { includeManagerDebugView: "true" } : {}),
      },
    }),
  );
}

export async function getEnvironmentDiff(
  id: string,
  selection: ThreadGitDiffSelection,
  mergeBaseBranch: string,
): Promise<ThreadGitDiffResponse> {
  const query =
    selection.type === "commit"
      ? {
          selection: "commit" as const,
          commitSha: selection.sha,
          mergeBaseBranch,
        }
      : {
          selection: "combined" as const,
          mergeBaseBranch,
        };

  return request<ThreadGitDiffResponse>(
    apiClient.environments[":id"].diff.$get({
      param: { id },
      query,
    }),
  );
}

export async function getAvailableModels(providerId?: string): Promise<AvailableModel[]> {
  return request<AvailableModel[]>(
    apiClient.system.models.$get({
      query: {
        ...(providerId ? { providerId } : {}),
      },
    }),
  );
}

export async function listSystemProviders(): Promise<SystemProviderInfo[]> {
  return request<SystemProviderInfo[]>(apiClient.system.providers.$get({ query: {} }));
}

export async function listHosts(): Promise<Host[]> {
  return request<Host[]>(apiClient.hosts.$get());
}
