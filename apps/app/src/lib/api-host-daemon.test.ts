// @vitest-environment jsdom

import {
  openWorkspaceRequestSchema,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils"

async function importFreshApiHostDaemon(): Promise<typeof import("./api-host-daemon")> {
  vi.resetModules()
  return import("./api-host-daemon")
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("api-host-daemon", () => {
  it("reuses the daemon client for the same port and recreates it when the port changes", async () => {
    const { getHostDaemonClient } = await importFreshApiHostDaemon()

    const firstClient = getHostDaemonClient(3002)
    const secondClient = getHostDaemonClient(3002)
    const thirdClient = getHostDaemonClient(4000)

    expect(secondClient).toBe(firstClient)
    expect(thirdClient).not.toBe(firstClient)
  })

  it("returns the daemon status when the daemon is reachable", async () => {
    installFetchRoutes([
      {
        pathname: "/status",
        port: 3002,
        handler: async () => jsonResponse({
          connected: true,
          hostId: "host_1",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        }),
      },
    ])

    const { fetchHostStatus } = await importFreshApiHostDaemon()

    await expect(fetchHostStatus(3002)).resolves.toEqual({
      connected: true,
      hostId: "host_1",
      serverUrl: "http://localhost:3334",
      supportsNativeFolderPicker: true,
      platform: "darwin",
    })
  })

  it("returns null when daemon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))

    const { fetchHostStatus } = await importFreshApiHostDaemon()

    await expect(fetchHostStatus(3002)).resolves.toBeNull()
  })

  it("returns null when status response is not ok", async () => {
    installFetchRoutes([
      {
        pathname: "/status",
        port: 3002,
        handler: async () => new Response(null, { status: 503 }),
      },
    ])

    const { fetchHostStatus } = await importFreshApiHostDaemon()

    await expect(fetchHostStatus(3002)).resolves.toBeNull()
  })

  it("returns the existence map for each path", async () => {
    installFetchRoutes([
      {
        method: "POST",
        pathname: "/paths/exist",
        port: 3002,
        handler: async () => jsonResponse({
          existence: { "/a": true, "/b": false },
        }),
      },
    ])

    const { checkPathsExist } = await importFreshApiHostDaemon()

    await expect(checkPathsExist(3002, ["/a", "/b"])).resolves.toEqual({
      "/a": true,
      "/b": false,
    })
  })

  it("short-circuits checkPathsExist when no paths are requested", async () => {
    const { checkPathsExist } = await importFreshApiHostDaemon()
    await expect(checkPathsExist(3002, [])).resolves.toEqual({})
  })

  it("throws when checkPathsExist hits an error response", async () => {
    installFetchRoutes([
      {
        method: "POST",
        pathname: "/paths/exist",
        port: 3002,
        handler: async () => new Response(null, { status: 500 }),
      },
    ])

    const { checkPathsExist } = await importFreshApiHostDaemon()

    await expect(checkPathsExist(3002, ["/a"])).rejects.toThrow(/Path existence check failed/)
  })

  it("returns hostId only when the daemon reports a connected host", async () => {
    installFetchRoutes([
      {
        pathname: "/status",
        port: 3002,
        handler: async () => jsonResponse({
          connected: false,
          hostId: "host_1",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: false,
          platform: "linux",
        }),
      },
    ])

    const { fetchHostId } = await importFreshApiHostDaemon()

    await expect(fetchHostId(3002)).resolves.toBeNull()
  })

  it("fetches workspace open targets from the daemon", async () => {
    const targets: WorkspaceOpenTarget[] = [
      {
        id: "vscode",
        label: "VS Code",
      },
    ]
    installFetchRoutes([
      {
        pathname: "/workspace-open-targets",
        port: 3002,
        handler: async () => jsonResponse({ targets }),
      },
    ])

    const { fetchWorkspaceOpenTargets } = await importFreshApiHostDaemon()

    await expect(fetchWorkspaceOpenTargets(3002)).resolves.toEqual(targets)
  })

  it("returns no workspace open targets when the daemon route is unavailable", async () => {
    installFetchRoutes([
      {
        pathname: "/workspace-open-targets",
        port: 3002,
        handler: async () => new Response(null, { status: 404 }),
      },
    ])

    const { fetchWorkspaceOpenTargets } = await importFreshApiHostDaemon()

    await expect(fetchWorkspaceOpenTargets(3002)).resolves.toEqual([])
  })

  it("rejects workspace open target discovery failures", async () => {
    installFetchRoutes([
      {
        pathname: "/workspace-open-targets",
        port: 3002,
        handler: async () => new Response(null, { status: 500 }),
      },
    ])

    const { fetchWorkspaceOpenTargets } = await importFreshApiHostDaemon()

    await expect(fetchWorkspaceOpenTargets(3002)).rejects.toThrow(
      "Workspace open target discovery failed: HTTP 500",
    )
  })

  it("rejects malformed workspace open target responses", async () => {
    installFetchRoutes([
      {
        pathname: "/workspace-open-targets",
        port: 3002,
        handler: async () => jsonResponse({ targets: [{ label: "VS Code" }] }),
      },
    ])

    const { fetchWorkspaceOpenTargets } = await importFreshApiHostDaemon()

    await expect(fetchWorkspaceOpenTargets(3002)).rejects.toThrow()
  })

  it("opens a workspace with a selected target", async () => {
    const requests: Array<ReturnType<typeof openWorkspaceRequestSchema.parse>> = []
    installFetchRoutes([
      {
        method: "POST",
        pathname: "/open-workspace",
        port: 3002,
        handler: async (request) => {
          requests.push(openWorkspaceRequestSchema.parse(await request.json()))
          return jsonResponse({})
        },
      },
    ])

    const { openWorkspace } = await importFreshApiHostDaemon()

    await openWorkspace(3002, {
      path: "/tmp/workspace",
      targetId: "vscode",
    })

    expect(requests).toEqual([
      {
        path: "/tmp/workspace",
        targetId: "vscode",
      },
    ])
  })

  it("rejects failed workspace open requests", async () => {
    installFetchRoutes([
      {
        method: "POST",
        pathname: "/open-workspace",
        port: 3002,
        handler: async () => jsonResponse(
          { message: "Workspace open target is unavailable: VS Code" },
          { status: 400 },
        ),
      },
    ])

    const { openWorkspace } = await importFreshApiHostDaemon()

    await expect(
      openWorkspace(3002, {
        path: "/tmp/workspace",
        targetId: "vscode",
      }),
    ).rejects.toThrow("Workspace open target is unavailable: VS Code")
  })
})
