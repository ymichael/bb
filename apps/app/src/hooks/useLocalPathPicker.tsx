import { useCallback } from "react";
import { normalizeProjectPathInput } from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { useDialogState } from "@/hooks/useDialogState";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import type {
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/dialogs/ProjectPathDialog";

export interface LocalPathSubmitParams {
  path: string;
  hostId: string;
  target: ProjectPathDialogTarget;
  closeDialog: () => void;
}

interface UseLocalPathPickerOptions {
  isPending: boolean;
  submit: (params: LocalPathSubmitParams) => void;
}

export interface LocalPathPickerController {
  isAvailable: boolean;
  localHostId: string | null;
  openPicker: (target: ProjectPathDialogTarget) => void;
  platform: HostPlatform | null;
  projectPathDialog: ReturnType<typeof useDialogState<ProjectPathDialogTarget>>;
  submitProjectPath: ProjectPathDialogSubmitHandler;
}

export function useLocalPathPicker({
  isPending,
  submit,
}: UseLocalPathPickerOptions): LocalPathPickerController {
  const { localHostId, pickFolder, platform } = useHostDaemon();
  const projectPathDialog = useDialogState<ProjectPathDialogTarget>();
  const closeDialog = projectPathDialog.onClose;

  const submitPath = useCallback(
    (path: string, target: ProjectPathDialogTarget) => {
      if (isPending || !localHostId) return;
      submit({ path, hostId: localHostId, target, closeDialog });
    },
    [closeDialog, isPending, localHostId, submit],
  );

  const openPicker = useCallback(
    (target: ProjectPathDialogTarget) => {
      if (isPending || !localHostId) return;

      if (pickFolder) {
        void (async () => {
          const selectedPath = await pickFolder();
          if (!selectedPath) return;
          submitPath(normalizeProjectPathInput(selectedPath), target);
        })();
        return;
      }

      projectPathDialog.onOpen(target);
    },
    [isPending, localHostId, pickFolder, projectPathDialog, submitPath],
  );

  const submitProjectPath = useCallback<ProjectPathDialogSubmitHandler>(
    (target, path) => {
      submitPath(path, target);
    },
    [submitPath],
  );

  return {
    isAvailable: localHostId != null,
    localHostId,
    openPicker,
    platform,
    projectPathDialog,
    submitProjectPath,
  };
}
