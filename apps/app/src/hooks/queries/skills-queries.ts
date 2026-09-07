import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeleteSkillRequest, SkillSummary } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  projectSkillsQueryKey,
  skillContentQueryKey,
  skillFilesQueryKey,
  SKILL_CONTENT_QUERY_KEY,
  SKILL_FILES_QUERY_KEY,
} from "@/hooks/queries/query-keys";
import { invalidateProjectSkillsMutationQueries } from "@/hooks/cache-owners/skills-cache-effects";

export function useProjectSkills(projectId: string) {
  return useQuery({
    queryKey: projectSkillsQueryKey(projectId),
    queryFn: ({ signal }) =>
      sdk.skills.list({ projectId, environmentId: null, signal }),
    enabled: projectId.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useSkillContent(
  projectId: string,
  skill: SkillSummary | null,
  path: string,
) {
  return useQuery({
    queryKey: skill
      ? skillContentQueryKey(projectId, skill.id, path)
      : [SKILL_CONTENT_QUERY_KEY, projectId, "none", path],
    queryFn: ({ signal }) =>
      sdk.skills.getContent({
        projectId,
        skillId: skill!.id,
        path,
        environmentId: null,
        signal,
      }),
    enabled: skill !== null && projectId.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function prefetchSkillDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  skill: SkillSummary,
): void {
  void queryClient.prefetchQuery({
    queryKey: skillFilesQueryKey(projectId, skill.id),
    queryFn: ({ signal }) =>
      sdk.skills.listFiles({
        projectId,
        skillId: skill.id,
        environmentId: null,
        signal,
      }),
    staleTime: 5_000,
  });
  void queryClient.prefetchQuery({
    queryKey: skillContentQueryKey(projectId, skill.id, "SKILL.md"),
    queryFn: ({ signal }) =>
      sdk.skills.getContent({
        projectId,
        skillId: skill.id,
        path: "SKILL.md",
        environmentId: null,
        signal,
      }),
    staleTime: 5_000,
  });
}

export function useSkillFiles(projectId: string, skill: SkillSummary | null) {
  return useQuery({
    queryKey: skill
      ? skillFilesQueryKey(projectId, skill.id)
      : [SKILL_FILES_QUERY_KEY, projectId, "none"],
    queryFn: ({ signal }) =>
      sdk.skills.listFiles({
        projectId,
        skillId: skill!.id,
        environmentId: null,
        signal,
      }),
    enabled: skill !== null && projectId.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useDeleteSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to delete skill." },
    mutationFn: (body: DeleteSkillRequest) =>
      sdk.skills.remove({ projectId, ...body }),
    onSuccess: () => {
      invalidateProjectSkillsMutationQueries({ projectId, queryClient });
    },
  });
}
