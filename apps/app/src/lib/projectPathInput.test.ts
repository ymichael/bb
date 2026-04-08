import { describe, expect, it } from "vitest"
import {
  deriveProjectNameFromPath,
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
} from "./projectPathInput"

describe("projectPathInput", () => {
  const windowsProjectPath = "C:\\Users\\michael\\bb"
  const windowsProjectPathWithTrailingSeparator = "C:\\Users\\michael\\bb\\"
  const windowsRootPath = "C:\\"
  const uncProjectPath = "\\\\server\\share\\bb"

  it("derives a project name from POSIX paths", () => {
    expect(deriveProjectNameFromPath("/srv/repos/bb")).toBe("bb")
    expect(deriveProjectNameFromPath("/srv/repos/bb/")).toBe("bb")
  })

  it("derives a project name from Windows-style paths", () => {
    expect(deriveProjectNameFromPath(windowsProjectPath)).toBe("bb")
    expect(deriveProjectNameFromPath("C:/Users/michael/bb/")).toBe("bb")
  })

  it("does not derive a project name from filesystem roots", () => {
    expect(deriveProjectNameFromPath("/")).toBe("")
    expect(deriveProjectNameFromPath(windowsRootPath)).toBe("")
  })

  it("recognizes supported absolute paths", () => {
    expect(isAbsoluteProjectPath("/srv/repos/bb")).toBe(true)
    expect(isAbsoluteProjectPath(windowsProjectPath)).toBe(true)
    expect(isAbsoluteProjectPath(uncProjectPath)).toBe(true)
    expect(isAbsoluteProjectPath("C:Users\\michael\\bb")).toBe(false)
    expect(isAbsoluteProjectPath("relative/path")).toBe(false)
  })

  it("normalizes trailing separators without collapsing roots", () => {
    expect(normalizeProjectPathInput("/srv/repos/bb/")).toBe("/srv/repos/bb")
    expect(normalizeProjectPathInput(windowsProjectPathWithTrailingSeparator)).toBe(
      windowsProjectPath,
    )
    expect(normalizeProjectPathInput("/")).toBe("/")
    expect(normalizeProjectPathInput(windowsRootPath)).toBe(windowsRootPath)
  })
})
