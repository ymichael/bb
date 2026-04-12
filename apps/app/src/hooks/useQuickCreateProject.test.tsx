// @vitest-environment jsdom

import { Suspense, useEffect, type ReactNode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { Host } from "@bb/domain"
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils"
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness"
import { afterEach, describe, expect, it, vi } from "vitest"

interface HostOverrides extends Partial<Host> {}

interface QuickCreateFetchState {
  daemonConnected: boolean
  hostDaemonPort: number | null
  hosts: Host[]
}

function makeHost(overrides: HostOverrides = {}): Host {
  return {
    createdAt: 1,
    id: "host-1",
    lastSeenAt: 1,
    name: "Local Host",
    status: "connected",
    type: "persistent",
    updatedAt: 1,
    ...overrides,
  }
}

function createSuspenseWrapper() {
  const { wrapper: baseWrapper } = createQueryClientTestHarness()

  return ({ children }: { children: ReactNode }) =>
    baseWrapper({
      children: (
        <Suspense fallback={null}>
          {children}
        </Suspense>
      ),
    })
}

function installQuickCreateFetchRoutes(
  state: QuickCreateFetchState,
  createdProjectBodies: string[],
) {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: async () => jsonResponse({
        githubConnected: false,
        hostDaemonPort: state.hostDaemonPort,
        sandboxHostSupported: false,
        voiceTranscriptionEnabled: false,
      }),
    },
    {
      pathname: "/api/v1/hosts",
      handler: async () => jsonResponse(state.hosts),
    },
    {
      pathname: "/status",
      port: 4123,
      handler: async () =>
        state.daemonConnected
          ? jsonResponse({
            connected: true,
            hostId: "host-1",
            serverUrl: "http://localhost:3334",
            supportsNativeFolderPicker: false,
            platform: "linux",
          })
          : new Response(null, { status: 503 }),
    },
    {
      pathname: "/workspace-open-targets",
      port: 4123,
      handler: async () => new Response(null, { status: 404 }),
    },
    {
      method: "POST",
      pathname: "/api/v1/projects",
      handler: async (request) => {
        const bodyText = await request.text()
        createdProjectBodies.push(bodyText)

        return jsonResponse({
          createdAt: 1,
          id: "proj-1",
          name: "demo",
          sources: [],
          updatedAt: 1,
        })
      },
    },
  ])
}

async function importFreshUseQuickCreateProject(): Promise<
  typeof import("./useQuickCreateProject")
> {
  vi.resetModules()
  return import("./useQuickCreateProject")
}

function createQuickCreateProbe(
  useQuickCreateProject: typeof import("./useQuickCreateProject").useQuickCreateProject,
) {
  return function QuickCreateProbe({
    onSnapshot,
  }: {
    onSnapshot: (snapshot: ReturnType<typeof useQuickCreateProject>) => void
  }) {
    const value = useQuickCreateProject()

    useEffect(() => {
      onSnapshot(value)
    }, [onSnapshot, value])

    return (
      <div>
        <div data-testid="is-available">{String(value.isAvailable)}</div>
        <div data-testid="dialog-open">{String(value.projectPathDialog.isOpen)}</div>
      </div>
    )
  }
}

afterEach(() => {
  cleanup()
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useQuickCreateProject", () => {
  it("opens a path dialog whenever a local host is available", async () => {
    installQuickCreateFetchRoutes({
      daemonConnected: true,
      hostDaemonPort: 4123,
      hosts: [makeHost()],
    }, [])

    const latestSnapshot: { current: ReturnType<typeof import("./useQuickCreateProject").useQuickCreateProject> | null } = { current: null }
    const { useQuickCreateProject } = await importFreshUseQuickCreateProject()
    const QuickCreateProbe = createQuickCreateProbe(useQuickCreateProject)

    await act(async () => {
      render(<QuickCreateProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot }} />, {
        wrapper: createSuspenseWrapper(),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId("is-available").textContent).toBe("true")
    })

    act(() => {
      latestSnapshot.current?.openCreateDialog()
    })

    expect(latestSnapshot.current?.projectPathDialog.target).toEqual({ kind: "create" })
  })

  it("creates a project from the submitted absolute path and closes the dialog on success", async () => {
    const createdProjectBodies: string[] = []
    installQuickCreateFetchRoutes({
      daemonConnected: true,
      hostDaemonPort: 4123,
      hosts: [makeHost()],
    }, createdProjectBodies)

    const latestSnapshot: { current: ReturnType<typeof import("./useQuickCreateProject").useQuickCreateProject> | null } = { current: null }
    const { useQuickCreateProject } = await importFreshUseQuickCreateProject()
    const QuickCreateProbe = createQuickCreateProbe(useQuickCreateProject)

    await act(async () => {
      render(<QuickCreateProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot }} />, {
        wrapper: createSuspenseWrapper(),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId("is-available").textContent).toBe("true")
    })

    act(() => {
      latestSnapshot.current?.openCreateDialog()
    })

    act(() => {
      latestSnapshot.current?.submitProjectPath({ kind: "create" }, "/srv/repos/demo")
    })

    await waitFor(() => {
      expect(createdProjectBodies).toHaveLength(1)
    })

    expect(JSON.parse(createdProjectBodies[0]) as object).toEqual({
      name: "demo",
      source: {
        hostId: "host-1",
        path: "/srv/repos/demo",
        type: "local_path",
      },
    })
    await waitFor(() => {
      expect(screen.getByTestId("dialog-open").textContent).toBe("false")
    })
  })

  it("does not open the create dialog when no local host is available", async () => {
    installQuickCreateFetchRoutes({
      daemonConnected: false,
      hostDaemonPort: null,
      hosts: [],
    }, [])

    const latestSnapshot: { current: ReturnType<typeof import("./useQuickCreateProject").useQuickCreateProject> | null } = { current: null }
    const { useQuickCreateProject } = await importFreshUseQuickCreateProject()
    const QuickCreateProbe = createQuickCreateProbe(useQuickCreateProject)

    await act(async () => {
      render(<QuickCreateProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot }} />, {
        wrapper: createSuspenseWrapper(),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId("is-available").textContent).toBe("false")
    })

    act(() => {
      latestSnapshot.current?.openCreateDialog()
    })

    expect(latestSnapshot.current?.projectPathDialog.target).toBeNull()
  })

  it("ignores create submissions that do not produce a project name", async () => {
    const createdProjectBodies: string[] = []
    installQuickCreateFetchRoutes({
      daemonConnected: true,
      hostDaemonPort: 4123,
      hosts: [makeHost()],
    }, createdProjectBodies)

    const latestSnapshot: { current: ReturnType<typeof import("./useQuickCreateProject").useQuickCreateProject> | null } = { current: null }
    const { useQuickCreateProject } = await importFreshUseQuickCreateProject()
    const QuickCreateProbe = createQuickCreateProbe(useQuickCreateProject)

    await act(async () => {
      render(<QuickCreateProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot }} />, {
        wrapper: createSuspenseWrapper(),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId("is-available").textContent).toBe("true")
    })

    act(() => {
      latestSnapshot.current?.openCreateDialog()
    })

    act(() => {
      latestSnapshot.current?.submitProjectPath({ kind: "create" }, "/")
    })

    expect(createdProjectBodies).toHaveLength(0)
    expect(latestSnapshot.current?.projectPathDialog.isOpen).toBe(true)
  })

  it("ignores non-create submissions", async () => {
    const createdProjectBodies: string[] = []
    installQuickCreateFetchRoutes({
      daemonConnected: true,
      hostDaemonPort: 4123,
      hosts: [makeHost()],
    }, createdProjectBodies)

    const latestSnapshot: { current: ReturnType<typeof import("./useQuickCreateProject").useQuickCreateProject> | null } = { current: null }
    const { useQuickCreateProject } = await importFreshUseQuickCreateProject()
    const QuickCreateProbe = createQuickCreateProbe(useQuickCreateProject)

    await act(async () => {
      render(<QuickCreateProbe onSnapshot={(snapshot) => { latestSnapshot.current = snapshot }} />, {
        wrapper: createSuspenseWrapper(),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId("is-available").textContent).toBe("true")
    })

    act(() => {
      latestSnapshot.current?.submitProjectPath(
        {
          currentPath: "/srv/repos/project-one",
          kind: "update",
          projectId: "proj-1",
          projectName: "Project One",
        },
        "/srv/repos/project-one",
      )
    })

    expect(createdProjectBodies).toHaveLength(0)
  })
})
