import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReasoningLevel, ThreadWithRuntime } from "@bb/domain";
import type {
  CreateProjectRequest,
  ManagerEnvironmentArgs,
  UpdateProjectRequest,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import { optimisticallyInsertThread } from "../queries/query-cache";
import { threadQueryKey } from "../queries/query-keys";
import {
  invalidateProjectListQueries,
  invalidateProjectDeleteQueries,
  invalidateProjectManagerHireQueries,
  invalidateProjectSourceQueries,
  invalidateProjectUpdateQueries,
} from "../cache-effects";

interface AddLocalProjectSourceRequest {
  projectId: string;
  hostId: string;
  path: string;
}

interface UpdateLocalProjectSourceRequest {
  projectId: string;
  sourceId: string;
  path: string;
}

export interface HireProjectManagerRequest {
  projectId: string;
  name?: string;
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  environment: ManagerEnvironmentArgs;
}

export const HIRE_PROJECT_MANAGER_MUTATION_KEY = [
  "hireProjectManager",
] as const;

interface UpdateProjectMutationRequest extends UpdateProjectRequest {
  id: string;
}

interface UploadPromptAttachmentRequest {
  projectId: string;
  file: File;
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to create project.",
    },
    mutationFn: (request: CreateProjectRequest) => api.createProject(request),
    onSuccess: () => {
      invalidateProjectListQueries({ queryClient });
    },
  });
}

export function useHireProjectManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: HIRE_PROJECT_MANAGER_MUTATION_KEY,
    meta: {
      errorMessage: "Failed to hire manager.",
      showErrorToast: false,
    },
    mutationFn: ({
      projectId,
      name,
      providerId,
      model,
      reasoningLevel,
      environment,
    }: HireProjectManagerRequest) =>
      api.hireProjectManager(projectId, {
        name,
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningLevel ? { reasoningLevel } : {}),
        environment,
      }),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadWithRuntime>(
        threadQueryKey(thread.id),
        thread,
      );
      optimisticallyInsertThread(queryClient, thread);
      invalidateProjectManagerHireQueries({ queryClient });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update project.",
    },
    mutationFn: ({ id, ...request }: UpdateProjectMutationRequest) =>
      api.updateProject(id, request),
    onSuccess: (_data, variables) => {
      invalidateProjectUpdateQueries({ projectId: variables.id, queryClient });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to remove project.",
    },
    mutationFn: (projectId: string) => api.deleteProject(projectId),
    onSuccess: () => {
      invalidateProjectDeleteQueries({ queryClient });
    },
  });
}

export function useAddLocalProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to add local source.",
    },
    mutationFn: ({ projectId, hostId, path }: AddLocalProjectSourceRequest) =>
      api.addProjectSource(projectId, { type: "local_path", hostId, path }),
    onSuccess: () => {
      invalidateProjectSourceQueries({ queryClient });
    },
  });
}

export function useUpdateLocalProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update local source.",
    },
    mutationFn: ({
      projectId,
      sourceId,
      path,
    }: UpdateLocalProjectSourceRequest) =>
      api.updateProjectSource(projectId, sourceId, {
        type: "local_path",
        path,
      }),
    onSuccess: () => {
      invalidateProjectSourceQueries({ queryClient });
    },
  });
}

export function useUploadPromptAttachment() {
  return useMutation({
    meta: {
      errorMessage: "Failed to upload attachment.",
      showErrorToast: false,
    },
    mutationFn: ({
      projectId,
      file,
    }: UploadPromptAttachmentRequest): Promise<UploadedPromptAttachment> =>
      api.uploadPromptAttachment(projectId, file),
    retry: false,
  });
}
