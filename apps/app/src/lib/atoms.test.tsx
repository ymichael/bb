// @vitest-environment jsdom

import { createStore } from "jotai"
import { cleanup, waitFor } from "@testing-library/react"
import { resetFakeReconnectingWebSockets } from "@/test/fake-reconnecting-websocket"
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("partysocket/ws", async () => {
  const { FakeReconnectingWebSocket: FakeSocket } = await import("@/test/fake-reconnecting-websocket")
  return {
    default: FakeSocket,
  }
})

interface SystemConfigRouteState {
  configs: Array<{
    hostDaemonPort: number | null
    voiceTranscriptionEnabled: boolean
  }>
  daemonStatuses: Array<{
    connected: boolean
    hostId: string
    serverUrl: string
    supportsNativeFolderPicker: boolean
    platform: "darwin" | "linux" | "wsl"
  } | null>
}

interface AtomModules {
  FakeReconnectingWebSocket: typeof import("@/test/fake-reconnecting-websocket").FakeReconnectingWebSocket
  localHostIdAtom: typeof import("./atoms").localHostIdAtom
  systemConfigAtom: typeof import("./atoms").systemConfigAtom
  wsManager: typeof import("./ws").wsManager
}

function installAtomFetchRoutes(state: SystemConfigRouteState) {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: async () => {
        const nextConfig = state.configs.shift()
        if (!nextConfig) {
          throw new Error("Unexpected system config fetch")
        }

        return jsonResponse({
          githubConnected: false,
          hostDaemonPort: nextConfig.hostDaemonPort,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: nextConfig.voiceTranscriptionEnabled,
        })
      },
    },
    {
      pathname: "/status",
      port: 4123,
      handler: async () => {
        const nextStatus = state.daemonStatuses.shift()
        if (nextStatus == null) {
          return new Response(null, { status: 503 })
        }

        return jsonResponse(nextStatus)
      },
    },
  ])
}

async function importFreshAtomModules(): Promise<AtomModules> {
  vi.resetModules()

  const [{ localHostIdAtom, systemConfigAtom }, { wsManager }, { FakeReconnectingWebSocket }] = await Promise.all([
    import("./atoms"),
    import("./ws"),
    import("@/test/fake-reconnecting-websocket"),
  ])

  return {
    FakeReconnectingWebSocket,
    localHostIdAtom,
    systemConfigAtom,
    wsManager,
  }
}

afterEach(() => {
  cleanup()
  resetFakeReconnectingWebSockets()
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("atoms", () => {
  it("re-fetches config after websocket reconnects", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: null,
          voiceTranscriptionEnabled: false,
        },
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [],
    })

    const { FakeReconnectingWebSocket, systemConfigAtom, wsManager } = await importFreshAtomModules()
    const store = createStore()
    const unsubscribe = store.sub(systemConfigAtom, () => {})

    try {
      expect(await store.get(systemConfigAtom)).toMatchObject({
        hostDaemonPort: null,
      })

      wsManager.connect()
      const socket = FakeReconnectingWebSocket.latest()
      socket.open()
      socket.close()
      socket.open()

      await waitFor(async () => {
        expect(await store.get(systemConfigAtom)).toMatchObject({
          hostDaemonPort: 4123,
        })
      })

      wsManager.disconnect()
    } finally {
      unsubscribe()
    }
  })

  it("re-probes local host status when the websocket reports a host change", async () => {
    installAtomFetchRoutes({
      configs: [
        {
          hostDaemonPort: 4123,
          voiceTranscriptionEnabled: false,
        },
      ],
      daemonStatuses: [
        {
          connected: true,
          hostId: "host-1",
          serverUrl: "http://localhost:3334",
          supportsNativeFolderPicker: true,
          platform: "darwin",
        },
        null,
      ],
    })

    const { FakeReconnectingWebSocket, localHostIdAtom, wsManager } = await importFreshAtomModules()
    const store = createStore()
    const unsubscribe = store.sub(localHostIdAtom, () => {})

    try {
      expect(await store.get(localHostIdAtom)).toBe("host-1")

      wsManager.connect()
      const socket = FakeReconnectingWebSocket.latest()
      socket.open()
      socket.emitJson({
        changes: ["host-disconnected"],
        entity: "host",
        type: "changed",
      })

      await waitFor(async () => {
        expect(await store.get(localHostIdAtom)).toBeNull()
      })

      wsManager.disconnect()
    } finally {
      unsubscribe()
    }
  })
})
