import type { ApiClient } from "@bb/server-contract";
import type {
  FetchImplementation,
  JsonBodyOf,
  SdkResponseLike,
} from "./response.js";

export type BbSdkRuntime = "node" | "browser";

export interface BbSdkTransport {
  api: ApiClient["api"];
  baseUrl: string;
  fetch: FetchImplementation;
  realtimeUrl?: string;
  runtime: BbSdkRuntime;
  readJson<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<JsonBodyOf<TResponse>>;
  readVoid<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<void>;
  resolve<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<TResponse>;
  websocket?: BbRealtimeSocketFactory;
}

export interface BbRealtimeSocketMessageEvent {
  data: unknown;
}

export interface BbRealtimeSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: BbRealtimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: string): void;
}

export type BbRealtimeSocketFactory = (url: string) => BbRealtimeSocket;

export interface BbSdkContext {}

export interface CreateHttpTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  runtime: BbSdkRuntime;
  websocket?: BbRealtimeSocketFactory;
}
