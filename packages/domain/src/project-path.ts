const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:(?:[\\/]+)?$/u
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:(?:[\\/]+)/u
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+(?:[\\/]+)[^\\/]+/u

export const INVALID_PROJECT_PATH_MESSAGE =
  "Project path must be an absolute Linux or WSL path."
export const UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE =
  "Project path must use a Linux or WSL path like /home/me/repo or /mnt/c/Users/me/repo. Native Windows paths are not supported."

export function isNativeWindowsProjectPath(path: string): boolean {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return false
  }

  return (
    WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmedPath)
    || WINDOWS_UNC_PATH_PATTERN.test(trimmedPath)
  )
}

export function isAbsoluteProjectPath(path: string): boolean {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return false
  }

  return trimmedPath.startsWith("/")
}

export function normalizeProjectPathInput(path: string): string {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return ""
  }

  if (trimmedPath === "/") {
    return trimmedPath
  }

  return trimmedPath.replace(/\/+$/u, "")
}

export function getProjectPathValidationMessage(path: string): string | null {
  const normalizedPath = normalizeProjectPathInput(path)
  if (!normalizedPath) {
    return INVALID_PROJECT_PATH_MESSAGE
  }
  if (isNativeWindowsProjectPath(normalizedPath)) {
    return UNSUPPORTED_NATIVE_WINDOWS_PROJECT_PATH_MESSAGE
  }
  if (!isAbsoluteProjectPath(normalizedPath)) {
    return INVALID_PROJECT_PATH_MESSAGE
  }
  return null
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path)
  if (
    !normalizedPath
    || normalizedPath === "/"
    || isNativeWindowsProjectPath(normalizedPath)
    || !isAbsoluteProjectPath(normalizedPath)
  ) {
    return ""
  }

  const segments = normalizedPath.split("/").filter(Boolean)
  return segments.at(-1) ?? ""
}
