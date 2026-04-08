const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:(?:[\\/]+)$/u
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:(?:[\\/]+)/u
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+(?:[\\/]+)[^\\/]+/u

export function isAbsoluteProjectPath(path: string): boolean {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return false
  }

  return (
    trimmedPath.startsWith("/")
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmedPath)
    || WINDOWS_UNC_PATH_PATTERN.test(trimmedPath)
  )
}

export function normalizeProjectPathInput(path: string): string {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return ""
  }

  if (trimmedPath === "/") {
    return trimmedPath
  }

  if (WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath)) {
    const separator = trimmedPath.includes("/") ? "/" : "\\"
    return `${trimmedPath.slice(0, 2)}${separator}`
  }

  return trimmedPath.replace(/[\\/]+$/u, "")
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path)
  if (
    !normalizedPath
    || normalizedPath === "/"
    || WINDOWS_DRIVE_ROOT_PATTERN.test(normalizedPath)
  ) {
    return ""
  }

  const segments = normalizedPath.split(/[\\/]+/u).filter(Boolean)
  return segments.at(-1) ?? ""
}
