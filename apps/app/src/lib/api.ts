import type {
  Project,
  Thread,
  ThreadEvent,
  CreateProjectRequest,
  UpdateProjectRequest,
  SpawnThreadRequest,
  TellThreadRequest,
  SystemStatus,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  AvailableModel,
  ProjectFileSuggestion,
  ThreadExecutionOptions,
} from "@beanbag/agent-core";

const BASE = "/api/v1";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// --- Projects ---

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  return request<Project>("POST", "/projects", req);
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

export async function pickProjectFolder(): Promise<{ path: string | null }> {
  return request<{ path: string | null }>("POST", "/system/pick-folder");
}

// --- Threads ---

export async function spawnThread(req: SpawnThreadRequest): Promise<Thread> {
  return request<Thread>("POST", "/threads", req);
}

export async function listThreads(filters?: {
  projectId?: string;
  parentThreadId?: string;
  includeArchived?: boolean;
}): Promise<Thread[]> {
  const params = new URLSearchParams();
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentThreadId) {
    params.set("parentThreadId", filters.parentThreadId);
  }
  if (filters?.includeArchived !== undefined) {
    params.set("includeArchived", String(filters.includeArchived));
  }
  const qs = params.toString();
  return request<Thread[]>("GET", `/threads${qs ? `?${qs}` : ""}`);
}

export async function getThread(id: string): Promise<Thread> {
  return request<Thread>("GET", `/threads/${id}`);
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

export async function stopThread(id: string): Promise<void> {
  return request<void>("POST", `/threads/${id}/stop`);
}

export async function archiveThread(id: string): Promise<void> {
  return request<void>("POST", `/threads/${id}/archive`);
}

export async function getThreadEvents(
  id: string,
  afterSeq?: number
): Promise<ThreadEvent[]> {
  const params = new URLSearchParams();
  if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
  const qs = params.toString();
  return request<ThreadEvent[]>("GET", `/threads/${id}/events${qs ? `?${qs}` : ""}`);
}

export async function getThreadOutput(id: string): Promise<{ output: string }> {
  return request<{ output: string }>("GET", `/threads/${id}/output`);
}

// --- System ---

export async function getSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("GET", "/system/status");
}

export async function getAvailableModels(): Promise<AvailableModel[]> {
  return request<AvailableModel[]>("GET", "/system/models");
}

export async function getSystemProvider(): Promise<SystemProviderInfo> {
  return request<SystemProviderInfo>("GET", "/system/provider");
}

export async function listSystemProviders(): Promise<SystemProviderInfo[]> {
  return request<SystemProviderInfo[]>("GET", "/system/providers");
}

export async function getSystemEnvironment(): Promise<SystemEnvironmentInfo> {
  return request<SystemEnvironmentInfo>("GET", "/system/environment");
}

export async function listSystemEnvironments(): Promise<SystemEnvironmentInfo[]> {
  return request<SystemEnvironmentInfo[]>("GET", "/system/environments");
}
