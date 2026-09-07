export interface RealtimeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: RealtimeSocketErrorEvent) => void) | null;
}

export interface RealtimeSocketErrorEvent {
  message: string | null;
}

export const SOCKET_OPEN = 1;

export interface RealtimeSocketOptions {
  headers: Record<string, string>;
}

export type RealtimeSocketFactory = (
  url: string,
  options: RealtimeSocketOptions,
) => RealtimeSocketLike;

type WebSocketWithOptionsConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

function socketErrorMessage(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const message = (event as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

export const defaultRealtimeSocketFactory: RealtimeSocketFactory = (
  url,
  options,
) => {
  const hasHeaders = Object.keys(options.headers).length > 0;
  const socket = hasHeaders
    ? new (WebSocket as unknown as WebSocketWithOptionsConstructor)(url, null, {
        headers: options.headers,
      })
    : new WebSocket(url);
  const adapter: RealtimeSocketLike = {
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
  socket.onopen = () => adapter.onopen?.();
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onclose = (event) =>
    adapter.onclose?.({ code: event.code, reason: event.reason });
  socket.onerror = (event) =>
    adapter.onerror?.({ message: socketErrorMessage(event) });
  return adapter;
};
