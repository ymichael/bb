import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReasoningLevel, Thread } from "@bb/domain";
import type {
  CreateProjectRequest,
  ManagerEnvironmentArgs,
  UpdateProjectRequest,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import {
  optimisticallyInsertThread,
} from "../queries/query-cache";
import {
  projectFilesQueryKeyPrefix,
  projectsQueryKey,
  statusQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";

interface HireProjectManagerRequest {
  projectId: string;
  name?: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  environment: ManagerEnvironmentArgs;
}

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
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
    },
  });
}

export function useHireProjectManager() {
  const queryClient = useQueryClient();

  return useMutation({
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
        providerId,
        model,
        reasoningLevel,
        environment,
      }),
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread>(threadQueryKey(thread.id), thread);
      optimisticallyInsertThread(queryClient, thread);

      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
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
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      queryClient.invalidateQueries({
        queryKey: projectFilesQueryKeyPrefix(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
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
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: statusQueryKey() });
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
