import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { deriveProjectNameFromPath } from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import type {
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/dialogs/ProjectPathDialog";

export interface QuickCreateProjectDialogState {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  target: ProjectPathDialogTarget | null;
}

export interface QuickCreateProjectController {
  isAvailable: boolean;
  isCreating: boolean;
  openCreateDialog: () => void;
  platform: HostPlatform | null;
  projectPathDialog: QuickCreateProjectDialogState;
  submitProjectPath: ProjectPathDialogSubmitHandler;
}

const quickCreateProjectContext =
  createContext<QuickCreateProjectController | null>(null);

export function useQuickCreateProject(): QuickCreateProjectController {
  const { mutate, isPending } = useCreateProject();

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
        { onSuccess: closeDialog },
      );
    },
    [mutate],
  );

  const controller = useLocalPathPicker({
    isPending,
    submit,
  });

  const openCreateDialog = useCallback(() => {
    controller.openPicker({ kind: "create" });
  }, [controller]);

  return useMemo(
    () => ({
      isAvailable: controller.isAvailable,
      isCreating: isPending,
      openCreateDialog,
      platform: controller.platform,
      projectPathDialog: controller.projectPathDialog,
      submitProjectPath: controller.submitProjectPath,
    }),
    [controller, isPending, openCreateDialog],
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
