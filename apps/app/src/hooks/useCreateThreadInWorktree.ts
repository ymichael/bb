import { useCallback } from "react";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";

interface UseCreateThreadInWorktreeArgs {
  projectId: string;
  environmentId: string;
}

export function useCreateThreadInWorktree({
  projectId,
  environmentId,
}: UseCreateThreadInWorktreeArgs): () => void {
  const navigate = useRouteNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  return useCallback(() => {
    setRootComposeProjectId(projectId);
    navigate(getRootComposeRoutePath(), {
      state: { reuseEnvironmentId: environmentId },
    });
  }, [environmentId, navigate, projectId, setRootComposeProjectId]);
}
