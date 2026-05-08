import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import type { ProjectResponse } from "@bb/server-contract";
import {
  useAddLocalProjectSource,
  useDeleteProject,
  useUpdateProject,
} from "@/hooks/mutations/project-mutations";
import { useDialogState } from "@/hooks/useDialogState";
import {
  useLocalPathPicker,
  type LocalPathSubmitParams,
} from "@/hooks/useLocalPathPicker";
import { ProjectPathDialog } from "@/components/project/ProjectPathDialog";
import {
  ProjectDeleteDialog,
  type ProjectDeleteDialogTarget,
} from "@/components/project/ProjectDeleteDialog";
import {
  ProjectRenameDialog,
  type ProjectRenameDialogTarget,
} from "@/components/project/ProjectRenameDialog";
import { collapsedProjectIdsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";

export interface ProjectActionsContextValue {
  requestRename: (project: ProjectResponse) => void;
  requestDelete: (project: ProjectResponse) => void;
  requestAddLocalPath: (project: ProjectResponse) => void;
}

const ProjectActionsContext = createContext<ProjectActionsContextValue | null>(
  null,
);

export function useProjectActions(): ProjectActionsContextValue {
  const value = useContext(ProjectActionsContext);
  if (!value) {
    throw new Error(
      "useProjectActions must be used within a <ProjectActionsProvider>",
    );
  }
  return value;
}

interface ProjectActionsProviderProps {
  children: ReactNode;
}

export function ProjectActionsProvider({
  children,
}: ProjectActionsProviderProps) {
  const navigate = useNavigate();
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const addLocalSource = useAddLocalProjectSource();
  // Destructure `.mutate` so useCallback deps see a stable reference across
  // renders. Depending on the full mutation object would churn the callback
  // identity on every isPending flip and force every useProjectActions()
  // consumer to re-render.
  const { mutate: updateProjectMutate } = updateProject;
  const { mutate: deleteProjectMutate } = deleteProject;
  const { mutate: addLocalSourceMutate } = addLocalSource;

  const renameDialog = useDialogState<ProjectRenameDialogTarget>();
  const deleteDialog = useDialogState<ProjectDeleteDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;
  const { onClose: closeDeleteDialog, onOpen: openDeleteDialog } = deleteDialog;

  const addLocalSourceSubmit = useCallback(
    ({ path, hostId, target, closeDialog }: LocalPathSubmitParams) => {
      if (target.kind !== "add-source") return;
      addLocalSourceMutate(
        { projectId: target.projectId, path, hostId },
        { onSuccess: closeDialog },
      );
    },
    [addLocalSourceMutate],
  );
  const addLocalSourcePicker = useLocalPathPicker({
    isPending: addLocalSource.isPending,
    submit: addLocalSourceSubmit,
  });

  const requestRename = useCallback(
    (project: ProjectResponse) => {
      openRenameDialog({ id: project.id, currentName: project.name });
    },
    [openRenameDialog],
  );

  const submitRename = useCallback(
    (projectId: string, name: string) => {
      updateProjectMutate(
        { id: projectId, name },
        { onSuccess: () => closeRenameDialog() },
      );
    },
    [closeRenameDialog, updateProjectMutate],
  );

  const requestDelete = useCallback(
    (project: ProjectResponse) => {
      openDeleteDialog({ id: project.id, name: project.name });
    },
    [openDeleteDialog],
  );

  const confirmDelete = useCallback(
    (projectId: string) => {
      deleteProjectMutate(projectId, {
        onSuccess: () => {
          closeDeleteDialog();
          // Drop the deleted project from the collapsed-state set so stale
          // ids don't accumulate in localStorage.
          setCollapsedProjectIdList((current) =>
            current.filter((id) => id !== projectId),
          );
          navigate("/", { replace: true });
        },
      });
    },
    [
      closeDeleteDialog,
      deleteProjectMutate,
      navigate,
      setCollapsedProjectIdList,
    ],
  );

  const requestAddLocalPath = useCallback(
    (project: ProjectResponse) => {
      addLocalSourcePicker.openPicker({
        kind: "add-source",
        projectId: project.id,
        projectName: project.name,
      });
    },
    [addLocalSourcePicker],
  );

  const value = useMemo<ProjectActionsContextValue>(
    () => ({
      requestRename,
      requestDelete,
      requestAddLocalPath,
    }),
    [requestRename, requestDelete, requestAddLocalPath],
  );

  return (
    <ProjectActionsContext.Provider value={value}>
      {children}
      <ProjectRenameDialog
        target={renameDialog.target}
        pending={updateProject.isPending}
        onOpenChange={renameDialog.onOpenChange}
        onRename={submitRename}
      />
      <ProjectDeleteDialog
        target={deleteDialog.target}
        pending={deleteProject.isPending}
        onOpenChange={deleteDialog.onOpenChange}
        onDelete={confirmDelete}
      />
      <ProjectPathDialog
        target={addLocalSourcePicker.projectPathDialog.target}
        pending={addLocalSource.isPending}
        platform={addLocalSourcePicker.platform}
        onOpenChange={addLocalSourcePicker.projectPathDialog.onOpenChange}
        onSubmit={addLocalSourcePicker.submitProjectPath}
      />
    </ProjectActionsContext.Provider>
  );
}
