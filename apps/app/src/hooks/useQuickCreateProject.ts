import { useCallback } from "react"
import { useCreateProject } from "@/hooks/useApi"
import { useHostDaemon } from "@/hooks/useHostDaemon"
import { deriveProjectNameFromPath } from "@/lib/projectPathInput"

export function useQuickCreateProject() {
  const { mutate, isPending } = useCreateProject()
  const { localHostId, pickFolder } = useHostDaemon()

  const createFromPicker = useCallback(async () => {
    if (isPending || !pickFolder || !localHostId) return

    const selectedPath = await pickFolder()
    if (!selectedPath) return

    const name = deriveProjectNameFromPath(selectedPath).trim()
    if (!name) {
      window.alert(
        "Could not derive a project name from the selected folder."
      )
      return
    }

    mutate({ name, source: { type: "local_path", hostId: localHostId, path: selectedPath } })
  }, [isPending, mutate, pickFolder, localHostId])

  const isAvailable = pickFolder != null && localHostId != null

  return { createFromPicker, isCreating: isPending, isAvailable }
}
