import type { QueryClientArg } from "../cache-effect-types";
import { projectSkillsQueryKey } from "../queries/query-keys";
import { invalidateQueryKeys } from "./cache-effect-utils";

interface ProjectSkillsInvalidationArg extends QueryClientArg {
  projectId: string;
}

export function invalidateProjectSkillsMutationQueries({
  projectId,
  queryClient,
}: ProjectSkillsInvalidationArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [projectSkillsQueryKey(projectId)],
  });
}
