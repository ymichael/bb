import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath, type Host } from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import {
  APP_ROOT_ROUTE_PATH,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import type {
  ProjectPathDialogProject,
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/dialogs/ProjectPathDialog";

interface QuickCreateProjectDialogState {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  target: ProjectPathDialogTarget | null;
}

interface QuickCreateProjectController {
  isAvailable: boolean;
  isCreating: boolean;
  openCreateDialog: () => void;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts: readonly Host[];
  projects: readonly ProjectPathDialogProject[];
  projectPathDialog: QuickCreateProjectDialogState;
  submitProjectPath: ProjectPathDialogSubmitHandler;
}

const quickCreateProjectContext =
  createContext<QuickCreateProjectController | null>(null);
const EMPTY_HOSTS: readonly Host[] = [];

export function useQuickCreateProject(): QuickCreateProjectController {
  const { mutate, isPending } = useCreateProject();
  const hostsQuery = useHosts();
  const hosts = hostsQuery.data ?? EMPTY_HOSTS;
  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo<readonly ProjectPathDialogProject[]>(
    () =>
      (sidebarNavigationQuery.data?.projects ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        sources: project.sources.map((source) => ({
          hostId: source.hostId,
          path: source.path,
        })),
      })),
    [sidebarNavigationQuery.data],
  );
  const navigate = useNavigate();
  const location = useLocation();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const shouldReplaceRoute = location.pathname === APP_ROOT_ROUTE_PATH;

  const submit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (target.kind !== "create") return;
      const name = deriveProjectNameFromPath(path).trim();
      if (!name) return;

      mutate(
        {
          name,
          source: { type: "local_path", hostId, path },
        },
        {
          onSuccess: (project) => {
            closeDialog();
            setRootComposeProjectId(project.id);
            void navigate(getRootComposeRoutePath(), {
              replace: shouldReplaceRoute,
            });
          },
        },
      );
    },
    [mutate, navigate, setRootComposeProjectId, shouldReplaceRoute],
  );

  const controller = useLocalPathPicker({
    isPending,
    submit,
  });

  const openCreateDialog = useCallback(() => {
    controller.openPathEntry({ kind: "create" });
  }, [controller]);
  return useMemo(
    () => ({
      isAvailable: controller.isAvailable,
      isCreating: isPending,
      openCreateDialog,
      platform: controller.platform,
      hostId: controller.hostId,
      hostName: controller.hostName,
      hosts,
      projects,
      projectPathDialog: controller.projectPathDialog,
      submitProjectPath: controller.submitProjectPath,
    }),
    [controller, hosts, isPending, openCreateDialog, projects],
  );
}

interface QuickCreateProjectProviderProps {
  children: ReactNode;
}

export function QuickCreateProjectProvider({
  children,
}: QuickCreateProjectProviderProps) {
  const quickCreateProject = useQuickCreateProject();

  return (
    <quickCreateProjectContext.Provider value={quickCreateProject}>
      {children}
    </quickCreateProjectContext.Provider>
  );
}

export function useQuickCreateProjectController(): QuickCreateProjectController {
  const quickCreateProject = useContext(quickCreateProjectContext);
  if (!quickCreateProject) {
    throw new Error("QuickCreateProjectProvider is required");
  }
  return quickCreateProject;
}
