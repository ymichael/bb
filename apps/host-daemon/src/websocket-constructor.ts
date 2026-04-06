import { WebSocket as NodeWebSocket } from "ws";
export interface NodeWebSocketConstructor {
  new (address: string | URL, protocols?: string | string[]): object;
}

export function createNodeWebSocketConstructor(
  headers: Record<string, string> | undefined,
): NodeWebSocketConstructor {
  if (!headers) {
    return NodeWebSocket;
  }

  return class HeaderAwareWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      return Reflect.construct(NodeWebSocket, [address, protocols, { headers }]);
    }
  };
}
