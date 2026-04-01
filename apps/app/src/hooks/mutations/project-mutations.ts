import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReasoningLevel, Thread } from "@bb/domain";
import type {
  CreateProjectRequest,
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
    mutationFn: (request: CreateProjectRequest) => api.createProject(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
    },
  });
}

export function useHireProjectManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      name,
      providerId,
      model,
      reasoningLevel,
    }: HireProjectManagerRequest) =>
      api.hireProjectManager(projectId, {
        name,
        providerId,
        model,
        reasoningLevel,
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
    mutationFn: ({
      projectId,
      file,
    }: UploadPromptAttachmentRequest): Promise<UploadedPromptAttachment> =>
      api.uploadPromptAttachment(projectId, file),
    retry: false,
  });
}
