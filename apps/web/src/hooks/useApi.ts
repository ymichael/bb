import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Project,
  Task,
  TaskEvent,
  TaskStatus,
  AgentRole,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskChatRequest,
  Thread,
  ThreadEvent,
  CreateProjectRequest,
  SpawnThreadRequest,
  TellThreadRequest,
  SystemStatus,
  AvailableModel,
  ProjectFileSuggestion,
  ThreadExecutionOptions,
} from "@beanbag/core";
import * as api from "../lib/api";

// --- Projects ---

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateProjectRequest) => api.createProject(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

// --- Tasks ---

export function useTasks(filters?: {
  projectId?: string;
  status?: TaskStatus;
  parentId?: string;
}) {
  return useQuery<Task[]>({
    queryKey: ["tasks", filters],
    queryFn: () => api.listTasks(filters),
  });
}

export function useTask(id: string) {
  return useQuery<Task>({
    queryKey: ["task", id],
    queryFn: () => api.getTask(id),
    enabled: !!id,
  });
}

export function useTaskEvents(id: string) {
  return useQuery<TaskEvent[]>({
    queryKey: ["taskEvents", id],
    queryFn: () => api.getTaskEvents(id),
    enabled: !!id,
  });
}

export function useRoles() {
  return useQuery<AgentRole[]>({
    queryKey: ["roles"],
    queryFn: () => api.listRoles(),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateTaskRequest) => api.createTask(req),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["taskEvents", task.id] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateTaskRequest }) =>
      api.updateTask(id, req),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["taskEvents", task.id] });
    },
  });
}

export function useAssignTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, assignee }: { id: string; assignee: string }) =>
      api.assignTask(id, { assignee }),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["taskEvents", task.id] });
    },
  });
}

export function useSetTaskAssignee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, assignee }: { id: string; assignee: string }) =>
      api.updateTask(id, { assignee }),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["taskEvents", task.id] });
    },
  });
}

export function useTaskChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: TaskChatRequest }) =>
      api.chatTask(id, req),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["task", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["taskEvents", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents"] });
    },
  });
}

export function useArchiveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveTask(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["task", id] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["taskEvents", id] });
    },
  });
}

export function useProjectFileSuggestions(
  projectId: string | undefined,
  query: string | null,
  limit: number = 8,
) {
  const trimmedQuery = query?.trim() ?? "";
  return useQuery<ProjectFileSuggestion[]>({
    queryKey: ["projectFiles", projectId, trimmedQuery, limit],
    queryFn: () => api.searchProjectFiles(projectId ?? "", trimmedQuery, limit),
    enabled: Boolean(projectId) && trimmedQuery.length > 0,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// --- Query Hooks ---

export function useThreads(filters?: { projectId?: string }) {
  return useQuery<Thread[]>({
    queryKey: ["threads", filters],
    queryFn: () => api.listThreads(filters),
  });
}

export function useThread(id: string) {
  return useQuery<Thread>({
    queryKey: ["thread", id],
    queryFn: () => api.getThread(id),
    enabled: !!id,
  });
}

export function useThreadEvents(id: string) {
  return useQuery<ThreadEvent[]>({
    queryKey: ["threadEvents", id],
    queryFn: () => api.getThreadEvents(id),
    enabled: !!id,
  });
}

export function useThreadDefaultExecutionOptions(id: string) {
  return useQuery<ThreadExecutionOptions | null>({
    queryKey: ["threadDefaultExecutionOptions", id],
    queryFn: () => api.getThreadDefaultExecutionOptions(id),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });
}

export function useSystemStatus() {
  return useQuery<SystemStatus>({
    queryKey: ["status"],
    queryFn: () => api.getSystemStatus(),
  });
}

export function useAvailableModels() {
  return useQuery<AvailableModel[]>({
    queryKey: ["availableModels"],
    queryFn: () => api.getAvailableModels(),
    staleTime: 60_000,
  });
}

// --- Mutation Hooks ---

export function useSpawnThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SpawnThreadRequest) => api.spawnThread(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useTellThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      model,
      reasoningLevel,
      sandboxMode,
      mode,
    }: { id: string } & TellThreadRequest) =>
      api.tellThread(id, { input, model, reasoningLevel, sandboxMode, mode }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["thread", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["threadEvents", variables.id] });
      queryClient.invalidateQueries({
        queryKey: ["threadDefaultExecutionOptions", variables.id],
      });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useStopThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.stopThread(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["thread", id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

export function useArchiveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveThread(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["thread", id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
