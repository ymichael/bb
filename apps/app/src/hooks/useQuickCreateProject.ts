import { useCallback } from "react"
import { useCreateProject } from "@/hooks/useApi"
import {
  deriveProjectNameFromPath,
  requestProjectRootPath,
} from "@/lib/projectPathInput"

export function useQuickCreateProject() {
  const { mutate, isPending } = useCreateProject()

  const createFromPicker = useCallback(async () => {
    if (isPending) return

    const rootPath = await requestProjectRootPath()
    if (!rootPath) return

    const name = deriveProjectNameFromPath(rootPath).trim()
    if (!name || !rootPath) {
      window.alert(
        "Could not read a valid folder path. Please pick or enter a different path."
      )
      return
    }

    mutate({ name, rootPath })
  }, [isPending, mutate])

  return { createFromPicker, isCreating: isPending }
}
