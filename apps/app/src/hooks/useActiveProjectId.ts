import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useProjects } from "@/hooks/queries/project-queries";
import { useAppRoute } from "@/hooks/useAppRoute";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";

const LAST_ACTIVE_PROJECT_ID_KEY = "bb.lastActiveProjectId";

const lastActiveProjectIdStorage = createLocalStorageSyncStorage<string | null>(
  {
    parse: (storedValue) =>
      storedValue && storedValue.length > 0 ? storedValue : null,
    serialize: (value) => value ?? "",
  },
);

const lastActiveProjectIdAtom = atomWithStorage<string | null>(
  LAST_ACTIVE_PROJECT_ID_KEY,
  null,
  lastActiveProjectIdStorage,
  { getOnInit: true },
);

/**
 * Resolves the "current project" for sidebar actions and the root redirect.
 * Prefers the project in the URL; falls back to the most recently visited
 * project (persisted to localStorage), then to the first project in the
 * loaded list. Returns undefined while projects are still loading and the
 * URL has no project segment.
 *
 * Side effect: when the URL carries a `projectId`, it is written to the
 * persisted store so non-project routes (e.g. `/settings`) can keep
 * targeting the last project the user was in.
 */
export function useActiveProjectId(): string | undefined {
  const { projectId: urlProjectId } = useAppRoute();
  const { data: projects } = useProjects({ enabled: !urlProjectId });
  const setLastActive = useSetAtom(lastActiveProjectIdAtom);
  const lastActive = useAtomValue(lastActiveProjectIdAtom);

  useEffect(() => {
    if (urlProjectId) {
      setLastActive(urlProjectId);
    }
  }, [urlProjectId, setLastActive]);

  if (urlProjectId) return urlProjectId;
  if (!projects) return undefined;
  if (lastActive && projects.some((project) => project.id === lastActive)) {
    return lastActive;
  }
  return projects[0]?.id;
}
