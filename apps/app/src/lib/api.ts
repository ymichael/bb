import {
  decodeSystemShutdownBlockedResponse,
  extractErrorMessage,
  toRecord,
} from "@bb/core";
import type {
  EnvironmentRecord,
  Project,
  Thread,
  ThreadQueuedMessage,
  CreateProjectRequest,
  UpdateProjectRequest,
  SpawnThreadRequest,
  TellThreadRequest,
  EnqueueThreadMessageRequest,
  SendQueuedThreadMessageRequest,
  SendQueuedThreadMessageResponse,
  UpdateThreadRequest,
  SystemStatus,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  AvailableModel,
  ProjectFileSuggestion,
  ThreadExecutionOptions,
  ThreadWorkStatus,
  UploadedPromptAttachment,
  ThreadOperationRequest,
  ThreadOperationResponse,
  PromoteThreadResponse,
  DemotePrimaryResponse,
  PrimaryCheckoutStatus,
  ThreadTimelineResponse,
  ThreadToolGroupMessagesResponse,
  ThreadGitDiffSelection,
  ThreadGitDiffResponse,
  OpenPathTarget,
  OpenThreadPathRequest,
  SystemRestartPolicy,
  SystemRestartAcceptedResponse,
  SystemRestartRequest,
  SystemShutdownAcceptedResponse,
  SystemShutdownRequest,
  SystemShutdownBlockingThread,
} from "@bb/core";

const BASE = "/api/v1";
const MAX_ERROR_MESSAGE_LENGTH = 180;
const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;
const ERROR_EXTRACT_OPTS = { maxLength: MAX_ERROR_MESSAGE_LENGTH, legacyKeys: ["detail"] as const };

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export class SystemShutdownBlockedError extends Error {
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const requestInit: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(opts?.signal ? { signal: opts.signal } : {}),
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, requestInit);
  if (!res.ok) {
    await throwHttpError(res);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function upload<T>(
  path: string,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  const formData = new FormData();
  formData.set("file", file, file.name);

  const res = await fetch(`${BASE}${path}`, {
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

async function uploadWithForm<T>(
  path: string,
  fields: Record<string, string>,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  formData.set("file", file, file.name);

  const res = await fetch(`${BASE}${path}`, {
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

// --- Projects ---

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  return request<Project>("POST", "/projects", req);
}

export async function hireProjectManager(
  projectId: string,
  options?: { providerId?: string; model?: string },
): Promise<Thread> {
  return request<Thread>("POST", `/projects/${projectId}/manager`, options);
}

export async function updateProject(
  id: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  return request<Project>("PATCH", `/projects/${id}`, req);
}

export async function listProjects(): Promise<Project[]> {
  return request<Project[]>("GET", "/projects");
}

export async function deleteProject(id: string): Promise<void> {
  return request<void>("DELETE", `/projects/${id}`);
}

export async function searchProjectFiles(
  projectId: string,
  query: string,
  limit: number = 8,
): Promise<ProjectFileSuggestion[]> {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(limit));
  return request<ProjectFileSuggestion[]>(
    "GET",
    `/projects/${projectId}/files?${params.toString()}`,
  );
}

export async function uploadPromptAttachment(
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  return upload<UploadedPromptAttachment>(
    `/projects/${projectId}/attachments`,
    file,
  );
}

export async function getProjectWorkspaceStatus(projectId: string): Promise<ThreadWorkStatus> {
  return request<ThreadWorkStatus>("GET", `/projects/${projectId}/workspace-status`);
}

export async function transcribeVoiceInput(
  file: File,
  prompt?: string,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) {
    return upload<{ text: string }>("/system/voice-transcription", file, signal);
  }
  return uploadWithForm<{ text: string }>(
    "/system/voice-transcription",
    { prompt: trimmedPrompt },
    file,
    signal,
  );
}

export async function pickProjectFolder(): Promise<{ path: string | null }> {
  return request<{ path: string | null }>("POST", "/system/pick-folder");
}

export async function openPathInEditor(
  path: string,
  options?: {
    target?: OpenPathTarget;
    editor?: "system_default" | "vscode" | "cursor" | "zed" | "windsurf";
    command?: string;
  },
): Promise<void> {
  return request<void>("POST", "/system/open-path", {
    path,
    ...(options?.target ? { target: options.target } : {}),
    ...(options?.editor ? { editor: options.editor } : {}),
    ...(options?.command ? { command: options.command } : {}),
  });
}

export async function openThreadPathInEditor(
  threadId: string,
  req: OpenThreadPathRequest,
): Promise<void> {
  return request<void>("POST", `/threads/${threadId}/open-path`, req);
}

// --- Threads ---

export async function spawnThread(req: SpawnThreadRequest): Promise<Thread> {
  return request<Thread>("POST", "/threads", req);
}

export async function listThreads(filters?: {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeWorkStatus?: boolean;
}, signal?: AbortSignal): Promise<Thread[]> {
  const params = new URLSearchParams();
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentThreadId) {
    params.set("parentThreadId", filters.parentThreadId);
  }
  if (filters?.includeArchived !== undefined) {
    params.set("includeArchived", String(filters.includeArchived));
  }
  if (filters?.includeWorkStatus !== undefined) {
    params.set("includeWorkStatus", String(filters.includeWorkStatus));
  }
  const qs = params.toString();
  return request<Thread[]>("GET", `/threads${qs ? `?${qs}` : ""}`, undefined, { signal });
}

export async function getThread(id: string): Promise<Thread> {
  return request<Thread>("GET", `/threads/${id}`);
}

export interface ManagerWorkspaceFileEntry {
  path: string;
  size: number;
}

export async function listThreadManagerWorkspaceFiles(
  id: string,
): Promise<{ files: ManagerWorkspaceFileEntry[] }> {
  return request<{ files: ManagerWorkspaceFileEntry[] }>(
    "GET",
    `/threads/${id}/manager-workspace/files`,
  );
}

export async function getThreadManagerWorkspaceFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  const params = new URLSearchParams({ path });
  return request<{ path: string; content: string }>(
    "GET",
    `/threads/${id}/manager-workspace/file?${params.toString()}`,
  );
}

export async function updateThread(
  id: string,
  req: UpdateThreadRequest,
): Promise<Thread> {
  return request<Thread>("PATCH", `/threads/${id}`, req);
}

export async function getThreadDefaultExecutionOptions(
  id: string,
): Promise<ThreadExecutionOptions | null> {
  return request<ThreadExecutionOptions | null>(
    "GET",
    `/threads/${id}/default-execution-options`,
  );
}

export async function tellThread(id: string, req: TellThreadRequest): Promise<void> {
  return request<void>("POST", `/threads/${id}/tell`, req);
}

export async function enqueueThreadMessage(
  id: string,
  req: EnqueueThreadMessageRequest,
): Promise<ThreadQueuedMessage> {
  return request<ThreadQueuedMessage>("POST", `/threads/${id}/queue`, req);
}

export async function sendQueuedThreadMessage(
  id: string,
  queuedMessageId: string,
  req?: SendQueuedThreadMessageRequest,
): Promise<SendQueuedThreadMessageResponse> {
  return request<SendQueuedThreadMessageResponse>(
    "POST",
    `/threads/${id}/queue/${queuedMessageId}/send`,
    req ?? {},
  );
}

export async function deleteQueuedThreadMessage(
  id: string,
  queuedMessageId: string,
): Promise<void> {
  return request<void>("DELETE", `/threads/${id}/queue/${queuedMessageId}`);
}

export async function stopThread(id: string): Promise<void> {
  return request<void>("POST", `/threads/${id}/stop`);
}

export async function archiveThread(
  id: string,
  opts?: { force?: boolean },
): Promise<void> {
  return request<void>("POST", `/threads/${id}/archive`, {
    force: opts?.force === true,
  });
}

export async function unarchiveThread(id: string): Promise<void> {
  return request<void>("POST", `/threads/${id}/unarchive`);
}

export async function deleteThread(id: string): Promise<void> {
  return request<void>("DELETE", `/threads/${id}`);
}

export async function markThreadRead(id: string): Promise<Thread> {
  return request<Thread>("POST", `/threads/${id}/read`);
}

export async function markThreadUnread(id: string): Promise<Thread> {
  return request<Thread>("POST", `/threads/${id}/unread`);
}

export async function getThreadWorkStatus(
  id: string,
  mergeBaseBranch?: string,
): Promise<ThreadWorkStatus | null> {
  const params = new URLSearchParams();
  if (mergeBaseBranch) {
    params.set("mergeBaseBranch", mergeBaseBranch);
  }
  const qs = params.toString();
  return request<ThreadWorkStatus | null>(
    "GET",
    `/threads/${id}/work-status${qs ? `?${qs}` : ""}`,
  );
}

export async function getThreadMergeBaseBranches(id: string): Promise<string[]> {
  return request<string[]>("GET", `/threads/${id}/merge-base-branches`);
}

export async function getThreadPrimaryStatus(
  id: string,
): Promise<PrimaryCheckoutStatus> {
  return request<PrimaryCheckoutStatus>("GET", `/threads/${id}/primary-status`);
}

export async function requestThreadOperation(
  id: string,
  req: ThreadOperationRequest,
): Promise<ThreadOperationResponse> {
  return request<ThreadOperationResponse>("POST", `/threads/${id}/operations`, req);
}

export async function promoteThread(id: string): Promise<PromoteThreadResponse> {
  return request<PromoteThreadResponse>("POST", `/threads/${id}/promote`);
}

export async function demotePrimaryCheckout(
  id: string,
): Promise<DemotePrimaryResponse> {
  return request<DemotePrimaryResponse>("POST", `/threads/${id}/demote-primary`);
}

export async function getThreadTimeline(
  id: string,
  limit?: number,
  includeToolGroupMessages: boolean = false,
  includeManagerDebugView: boolean = false,
): Promise<ThreadTimelineResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (includeToolGroupMessages) params.set("includeToolGroupMessages", "true");
  if (includeManagerDebugView) params.set("includeManagerDebugView", "true");
  const qs = params.toString();
  return request<ThreadTimelineResponse>(
    "GET",
    `/threads/${id}/timeline${qs ? `?${qs}` : ""}`,
  );
}

export async function getThreadToolGroupMessages(
  id: string,
  turnId: string,
  sourceSeqStart: number,
  sourceSeqEnd: number,
  includeManagerDebugView: boolean = false,
): Promise<ThreadToolGroupMessagesResponse> {
  const params = new URLSearchParams();
  params.set("turnId", turnId);
  params.set("sourceSeqStart", String(sourceSeqStart));
  params.set("sourceSeqEnd", String(sourceSeqEnd));
  if (includeManagerDebugView) params.set("includeManagerDebugView", "true");
  return request<ThreadToolGroupMessagesResponse>(
    "GET",
    `/threads/${id}/tool-group-messages?${params.toString()}`,
  );
}

export async function getThreadGitDiff(
  id: string,
  selection?: ThreadGitDiffSelection,
  mergeBaseBranch?: string,
): Promise<ThreadGitDiffResponse> {
  const params = new URLSearchParams();
  if (selection?.type === "commit") {
    params.set("selection", "commit");
    params.set("commitSha", selection.sha);
  } else if (selection?.type === "combined") {
    params.set("selection", "combined");
  }
  if (mergeBaseBranch) {
    params.set("mergeBaseBranch", mergeBaseBranch);
  }
  const qs = params.toString();
  return request<ThreadGitDiffResponse>(
    "GET",
    `/threads/${id}/git-diff${qs ? `?${qs}` : ""}`,
  );
}

export async function getThreadOutput(id: string): Promise<{ output: string }> {
  return request<{ output: string }>("GET", `/threads/${id}/output`);
}

// --- System ---

export async function getSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("GET", "/system/status");
}

export async function getAvailableModels(providerId?: string): Promise<AvailableModel[]> {
  const params = new URLSearchParams();
  if (providerId) {
    params.set("providerId", providerId);
  }
  const qs = params.toString();
  return request<AvailableModel[]>("GET", `/system/models${qs ? `?${qs}` : ""}`);
}

export async function getSystemProvider(): Promise<SystemProviderInfo> {
  return request<SystemProviderInfo>("GET", "/system/provider");
}

export async function listSystemProviders(): Promise<SystemProviderInfo[]> {
  return request<SystemProviderInfo[]>("GET", "/system/providers");
}

export async function listSystemEnvironments(): Promise<SystemEnvironmentInfo[]> {
  return request<SystemEnvironmentInfo[]>("GET", "/system/environments");
}

export async function listEnvironments(projectId?: string): Promise<EnvironmentRecord[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return request<EnvironmentRecord[]>("GET", `/environments${query}`);
}

export async function getSystemRestartPolicy(): Promise<SystemRestartPolicy> {
  return request<SystemRestartPolicy>("GET", "/system/restart-policy");
}

export async function shutdownDaemon(
  req: SystemShutdownRequest = {},
): Promise<SystemShutdownAcceptedResponse> {
  const res = await fetch(`${BASE}/system/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (res.status === 409) {
    const rawBody = await res.text().catch(() => "");
    const normalized = normalizeErrorText(rawBody);
    if (normalized.length > 0) {
      try {
        const parsed = JSON.parse(normalized) as unknown;
        const blocked = decodeSystemShutdownBlockedResponse(parsed);
        if (blocked) {
          throw new SystemShutdownBlockedError(
            blocked.message,
            blocked.blockingThreads,
          );
        }
      } catch (err) {
        if (err instanceof SystemShutdownBlockedError) {
          throw err;
        }
      }
    }
    const message = deriveHttpErrorMessage(
      res.status,
      res.statusText,
      rawBody,
      res.headers.get("content-type"),
    );
    throw new Error(`HTTP ${res.status}: ${message}`);
  }

  if (!res.ok) {
    await throwHttpError(res);
  }

  const text = await res.text();
  if (!text) {
    return {
      ok: true,
      forced: Boolean(req.force),
      blockingThreadsCount: 0,
    };
  }
  return JSON.parse(text) as SystemShutdownAcceptedResponse;
}

export async function restartDaemon(
  req: SystemRestartRequest = {},
): Promise<SystemRestartAcceptedResponse> {
  const res = await fetch(`${BASE}/system/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (res.status === 409) {
    const rawBody = await res.text().catch(() => "");
    const normalized = normalizeErrorText(rawBody);
    if (normalized.length > 0) {
      try {
        const parsed = JSON.parse(normalized) as unknown;
        const blocked = decodeSystemShutdownBlockedResponse(parsed);
        if (blocked) {
          throw new SystemShutdownBlockedError(
            blocked.message,
            blocked.blockingThreads,
          );
        }
      } catch (err) {
        if (err instanceof SystemShutdownBlockedError) {
          throw err;
        }
      }
    }
    const message = deriveHttpErrorMessage(
      res.status,
      res.statusText,
      rawBody,
      res.headers.get("content-type"),
    );
    throw new Error(`HTTP ${res.status}: ${message}`);
  }

  if (!res.ok) {
    await throwHttpError(res);
  }

  const text = await res.text();
  if (!text) {
    return {
      ok: true,
      forced: Boolean(req.force),
      blockingThreadsCount: 0,
      restarting: true,
    };
  }
  return JSON.parse(text) as SystemRestartAcceptedResponse;
}
