import { useCallback } from "react"

export interface PickedDirectory {
  name: string
  path: string
}

function parseDirectoryFromFile(file: File): PickedDirectory | null {
  const withPath = file as File & { path?: string; webkitRelativePath?: string }
  const absoluteFilePath = withPath.path
  const relativePath = withPath.webkitRelativePath

  if (!absoluteFilePath || !relativePath) {
    return null
  }

  const directoryName = relativePath.split("/")[0]?.trim()
  if (!directoryName) {
    return null
  }

  const normalizedPath = absoluteFilePath.replace(/\\/g, "/")
  const marker = `/${directoryName}/`
  const markerIndex = normalizedPath.lastIndexOf(marker)

  if (markerIndex >= 0) {
    return {
      name: directoryName,
      path: normalizedPath.slice(0, markerIndex + directoryName.length + 1),
    }
  }

  const lastSlashIndex = normalizedPath.lastIndexOf("/")
  if (lastSlashIndex < 1) {
    return null
  }

  return {
    name: directoryName,
    path: normalizedPath.slice(0, lastSlashIndex),
  }
}

function pickWithInput(): Promise<PickedDirectory | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    ;(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory =
      true
    input.style.position = "fixed"
    input.style.left = "-9999px"

    const cleanup = () => {
      input.remove()
      window.removeEventListener("focus", handleWindowFocus)
    }

    const handleWindowFocus = () => {
      window.setTimeout(() => {
        // If no files were selected, treat it as a cancel.
        if (!input.files || input.files.length === 0) {
          cleanup()
          resolve(null)
        }
      }, 0)
    }

    input.addEventListener("change", () => {
      const firstFile = input.files?.[0]
      cleanup()
      if (!firstFile) {
        resolve(null)
        return
      }
      resolve(parseDirectoryFromFile(firstFile))
    })

    window.addEventListener("focus", handleWindowFocus, { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

const supportsPicker = typeof window !== "undefined"

export function useDirectoryPicker() {
  const pick = useCallback(async (): Promise<PickedDirectory | null> => {
    if (!supportsPicker) return null

    return pickWithInput()
  }, [])

  return { pick, supported: supportsPicker }
}
