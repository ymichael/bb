import {
  createContext,
  createElement,
  useCallback,
  useContext,
  type ReactNode,
} from "react"
import { deriveProjectNameFromPath } from "@bb/domain"
import { useCreateProject } from "@/hooks/mutations/project-mutations"
import { useDialogState } from "@/hooks/useDialogState"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import type {
  ProjectPathDialogFolderPicker,
  ProjectPathDialogSubmitHandler,
  ProjectPathDialogTarget,
} from "@/components/project/ProjectPathDialog"

export interface QuickCreateProjectDialogState {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  target: ProjectPathDialogTarget | null
}

export interface QuickCreateProjectController {
  isAvailable: boolean
  isCreating: boolean
  openCreateDialog: () => void
  pickFolder: ProjectPathDialogFolderPicker
  projectPathDialog: QuickCreateProjectDialogState
  submitProjectPath: ProjectPathDialogSubmitHandler
}

const quickCreateProjectContext = createContext<QuickCreateProjectController | null>(null)

export function useQuickCreateProject() {
  const { mutate, isPending } = useCreateProject()
  const { localHostId, pickFolder } = useHostDaemon()
  const projectPathDialog = useDialogState<ProjectPathDialogTarget>()

  const openCreateDialog = useCallback(() => {
    if (isPending || !localHostId) {
      return
    }

    projectPathDialog.onOpen({ kind: "create" })
  }, [isPending, localHostId, projectPathDialog])

  const submitProjectPath = useCallback((target: ProjectPathDialogTarget, path: string) => {
    if (isPending || target.kind !== "create" || !localHostId) return

    const name = deriveProjectNameFromPath(path).trim()
    if (!name) {
      return
    }

    mutate(
      {
        name,
        source: { type: "local_path", hostId: localHostId, path },
      },
      {
        onSuccess: () => {
          projectPathDialog.onClose()
        },
      },
    )
  }, [isPending, localHostId, mutate, projectPathDialog])

  const isAvailable = localHostId != null

  return {
    openCreateDialog,
    pickFolder,
    projectPathDialog,
    submitProjectPath,
    isCreating: isPending,
    isAvailable,
  }
}

interface QuickCreateProjectProviderProps {
  children: ReactNode
}

export function QuickCreateProjectProvider({
  children,
}: QuickCreateProjectProviderProps) {
  const quickCreateProject = useQuickCreateProject()

  return createElement(
    quickCreateProjectContext.Provider,
    { value: quickCreateProject },
    children,
  )
}

export function useQuickCreateProjectController(): QuickCreateProjectController {
  const quickCreateProject = useContext(quickCreateProjectContext)
  if (!quickCreateProject) {
    throw new Error("QuickCreateProjectProvider is required")
  }
  return quickCreateProject
}
