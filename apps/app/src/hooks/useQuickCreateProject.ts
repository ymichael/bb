import { useCallback } from "react"
import { deriveProjectNameFromPath } from "@bb/domain"
import { useCreateProject } from "@/hooks/mutations/project-mutations"
import { useDialogState } from "@/hooks/useDialogState"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import type { ProjectPathDialogTarget } from "@/components/project/ProjectPathDialog"

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
