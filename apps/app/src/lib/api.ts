import {
  extractErrorMessage,
  toRecord,
} from "@bb/core-ui";
import type {
  Environment,
  Project,
  Thread,
  ThreadType,
  ThreadExecutionOptions,
  ThreadGitDiffResponse,
  ThreadGitDiffSelection,
  ThreadQueuedMessage,
  WorkspaceStatus,
  AvailableModel,
  ReasoningLevel,
} from "@bb/domain";
import type {
  CommitOptions,
  CreateProjectRequest,
  CreateDraftRequest,
  EnvironmentActionResponse,
  OpenThreadPathRequest,
  ProjectFileSuggestion,
  SendDraftRequest,
  SendDraftResponse,
  CreateThreadRequest,
  SquashMergeOptions,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  SystemShutdownAcceptedResponse,
  SystemShutdownBlockedResponse,
  SystemShutdownBlockingThread,
  SystemShutdownRequest,
  SystemVoiceTranscriptionResponse,
  SendMessageRequest,
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
  UpdateProjectRequest,
  UpdateThreadRequest,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import { apiClient, toRelativeUrl } from "./api-client";

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

class SystemShutdownBlockedError extends Error {
  code: "shutdown_blocked";
  blockingThreads: SystemShutdownBlockingThread[];

  constructor(
    message: string,
    blockingThreads: SystemShutdownBlockingThread[],
  ) {
    super(message);
    this.name = "SystemShutdownBlockedError";
    this.code = "shutdown_blocked";
    this.blockingThreads = blockingThreads;
  }
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
  options?: { title?: string; providerId?: string; model?: string; reasoningLevel?: ReasoningLevel },
): Promise<Thread> {
  return request<Thread>(
    apiClient.projects[":id"].managers.$post({
      param: { id: projectId },
      json: options ?? {},
    }),
  );
}

export async function updateProject(
  id: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  return request<Project>(apiClient.projects[":id"].$patch({ param: { id }, json: req }));
}

export async function listProjects(): Promise<Project[]> {
  return request<Project[]>(apiClient.projects.$get());
}

export async function deleteProject(id: string): Promise<void> {
  await request<unknown>(apiClient.projects[":id"].$delete({ param: { id } }));
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

export async function getProjectWorkspaceStatus(projectId: string): Promise<WorkspaceStatus> {
  return request<WorkspaceStatus>(
    apiClient.projects[":id"]["work-status"].$get({ param: { id: projectId } }),
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

export async function pickProjectFolder(): Promise<{ path: string | null }> {
  return request<{ path: string | null }>(apiClient.system["pick-folder"].$post({}));
}

export async function openThreadPathInEditor(
  threadId: string,
  req: OpenThreadPathRequest,
): Promise<void> {
  await request<unknown>(
    apiClient.threads[":id"]["open-path"].$post({
      param: { id: threadId },
      json: req,
    }),
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
    includeWorkStatus?: boolean;
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
        ...(filters?.includeWorkStatus !== undefined
          ? { includeWorkStatus: String(filters.includeWorkStatus) as "true" | "false" }
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
    apiClient.threads[":id"]["manager-workspace"].files.$get({ param: { id } }),
  );
}

export async function getThreadManagerWorkspaceFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  return request<{ path: string; content: string }>(
    apiClient.threads[":id"]["manager-workspace"].file.$get({
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
): Promise<ThreadExecutionOptions | null> {
  return request<ThreadExecutionOptions | null>(
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
  req?: SendDraftRequest,
): Promise<SendDraftResponse> {
  return request<SendDraftResponse>(
    apiClient.threads[":id"].drafts[":draftId"].send.$post({
      param: { id, draftId: queuedMessageId },
      json: req ?? {},
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
  opts?: { force?: boolean },
): Promise<void> {
  await request<unknown>(
    apiClient.threads[":id"].archive.$post({
      param: { id },
      json: { force: opts?.force === true },
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

export async function getThreadWorkStatus(
  id: string,
  mergeBaseBranch?: string,
): Promise<WorkspaceStatus | null> {
  return request<WorkspaceStatus | null>(
    apiClient.threads[":id"]["work-status"].$get({
      param: { id },
      query: {
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
      },
    }),
  );
}

export async function getThreadDiffBranches(id: string): Promise<string[]> {
  return request<string[]>(
    apiClient.threads[":id"].diff.branches.$get({ param: { id } }),
  );
}

export async function requestEnvironmentAction(
  id: string,
  req: {
    action: "promote";
    initiatingThreadId: string;
  } | {
    action: "demote";
    initiatingThreadId: string;
  } | {
    action: "commit";
    initiatingThreadId: string;
    options?: CommitOptions;
  } | {
    action: "squash_merge";
    initiatingThreadId: string;
    options?: SquashMergeOptions;
  },
): Promise<EnvironmentActionResponse> {
  return request<EnvironmentActionResponse>(
    apiClient.environments[":id"].actions.$post({ param: { id }, json: req }),
  );
}

export async function getThreadTimeline(
  id: string,
  limit?: number,
  includeToolGroupMessages: boolean = false,
  includeManagerDebugView: boolean = false,
): Promise<ThreadTimelineResponse> {
  return request<ThreadTimelineResponse>(
    apiClient.threads[":id"].timeline.$get({
      param: { id },
      query: {
        ...(limit !== undefined ? { limit: String(limit) } : {}),
        ...(includeToolGroupMessages ? { includeToolGroupMessages: "true" as const } : {}),
        ...(includeManagerDebugView ? { includeManagerDebugView: "true" as const } : {}),
      },
    }),
  );
}

export async function getThreadTimelineToolDetails(
  id: string,
  turnId: string,
  sourceSeqStart: number,
  sourceSeqEnd: number,
  includeManagerDebugView: boolean = false,
): Promise<TimelineToolDetailsResponse> {
  return request<TimelineToolDetailsResponse>(
    apiClient.threads[":id"].timeline["tool-details"].$get({
      param: { id },
      query: {
        turnId,
        sourceSeqStart: String(sourceSeqStart),
        sourceSeqEnd: String(sourceSeqEnd),
        ...(includeManagerDebugView ? { includeManagerDebugView: "true" as const } : {}),
      },
    }),
  );
}

export async function getThreadDiff(
  id: string,
  selection?: ThreadGitDiffSelection,
  mergeBaseBranch?: string,
): Promise<ThreadGitDiffResponse> {
  return request<ThreadGitDiffResponse>(
    apiClient.threads[":id"].diff.$get({
      param: { id },
      query: {
        ...(selection?.type === "commit"
          ? { selection: "commit", commitSha: selection.sha }
          : selection?.type === "combined"
            ? { selection: "combined" }
            : {}),
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
      },
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

export async function listSystemEnvironments(): Promise<SystemEnvironmentInfo[]> {
  return request<SystemEnvironmentInfo[]>(apiClient.system.environments.$get());
}

export async function listEnvironments(projectId?: string): Promise<Environment[]> {
  return request<Environment[]>(
    apiClient.environments.$get({
      query: {
        ...(projectId ? { projectId } : {}),
      },
    }),
  );
}

function isShutdownBlocked(
  body: SystemShutdownAcceptedResponse | SystemShutdownBlockedResponse,
): body is SystemShutdownBlockedResponse {
  return "code" in body && body.code === "shutdown_blocked";
}

export async function shutdownServer(
  req: SystemShutdownRequest = {},
): Promise<SystemShutdownAcceptedResponse> {
  const res = await apiClient.system.shutdown.$post({ json: req });
  if (!res.ok && res.status !== 409) {
    await throwHttpError(res);
  }
  const body = await res.json();
  if (isShutdownBlocked(body)) {
    throw new SystemShutdownBlockedError(body.message, body.blockingThreads);
  }
  return body;
}
