import { useEffect, useState } from "react"
import { wsManager, type WebSocketConnectionState } from "@/lib/ws"

export function useDaemonConnectionState(): WebSocketConnectionState {
  const [connectionState, setConnectionState] = useState<WebSocketConnectionState>(
    () => wsManager.getConnectionState(),
  )

  useEffect(() => {
    return wsManager.onConnectionStateChange((state) => {
      setConnectionState(state)
    })
  }, [])

  return connectionState
}
