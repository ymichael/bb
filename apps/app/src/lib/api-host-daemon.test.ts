// @vitest-environment jsdom

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
})
