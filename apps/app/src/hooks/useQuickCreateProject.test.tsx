// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useQuickCreateProject } from "./useQuickCreateProject"

const { useCreateProject, useHostDaemon } = vi.hoisted(() => ({
  useCreateProject: vi.fn(),
  useHostDaemon: vi.fn(),
}))

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useCreateProject,
}))

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon,
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe("useQuickCreateProject", () => {
  it("opens a path dialog whenever a local host is available", () => {
    useCreateProject.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    })
    useHostDaemon.mockReturnValue({
      localHostId: "host-1",
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.openCreateDialog()
    })

    expect(result.current.isAvailable).toBe(true)
    expect(result.current.projectPathDialog.target).toEqual({ kind: "create" })
  })

  it("creates a project from the submitted absolute path and closes the dialog on success", () => {
    const mutate = vi.fn((_: object, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.()
    })
    useCreateProject.mockReturnValue({
      mutate,
      isPending: false,
    })
    useHostDaemon.mockReturnValue({
      localHostId: "host-1",
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.openCreateDialog()
    })

    act(() => {
      result.current.submitProjectPath({ kind: "create" }, "/srv/repos/demo")
    })

    expect(mutate).toHaveBeenCalledWith(
      {
        name: "demo",
        source: {
          type: "local_path",
          hostId: "host-1",
          path: "/srv/repos/demo",
        },
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      }),
    )
    expect(result.current.projectPathDialog.isOpen).toBe(false)
  })

  it("does not open the create dialog when no local host is available", () => {
    useCreateProject.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    })
    useHostDaemon.mockReturnValue({
      localHostId: null,
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.openCreateDialog()
    })

    expect(result.current.isAvailable).toBe(false)
    expect(result.current.projectPathDialog.target).toBeNull()
  })

  it("does not open the create dialog while a project mutation is pending", () => {
    useCreateProject.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
    })
    useHostDaemon.mockReturnValue({
      localHostId: "host-1",
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.openCreateDialog()
    })

    expect(result.current.projectPathDialog.target).toBeNull()
  })

  it("ignores create submissions that do not produce a project name", () => {
    const mutate = vi.fn()
    useCreateProject.mockReturnValue({
      mutate,
      isPending: false,
    })
    useHostDaemon.mockReturnValue({
      localHostId: "host-1",
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.openCreateDialog()
    })

    act(() => {
      result.current.submitProjectPath({ kind: "create" }, "/")
    })

    expect(mutate).not.toHaveBeenCalled()
    expect(result.current.projectPathDialog.isOpen).toBe(true)
  })

  it("ignores non-create submissions", () => {
    const mutate = vi.fn()
    useCreateProject.mockReturnValue({
      mutate,
      isPending: false,
    })
    useHostDaemon.mockReturnValue({
      localHostId: "host-1",
      pickFolder: null,
    })

    const { result } = renderHook(() => useQuickCreateProject())

    act(() => {
      result.current.submitProjectPath(
        {
          kind: "update",
          projectId: "proj-1",
          projectName: "Project One",
          currentPath: "/srv/repos/project-one",
        },
        "/srv/repos/project-one",
      )
    })

    expect(mutate).not.toHaveBeenCalled()
  })
})
