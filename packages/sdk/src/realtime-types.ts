import type { ChangedMessage } from "@bb/domain";

export type BbRealtimeUnsubscribe = () => void;

export type BbRealtimeEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed"
  | "system:changed"
  | "system:config-changed"
  | "realtime:connection";

export type ThreadRealtimeEvent = Extract<ChangedMessage, { entity: "thread" }>;
export type ProjectRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "project" }
>;
export type EnvironmentRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "environment" }
>;
export type HostRealtimeEvent = Extract<ChangedMessage, { entity: "host" }>;
export type SystemRealtimeEvent = Extract<ChangedMessage, { entity: "system" }>;

export type BbRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface BbRealtimeConnectionEvent {
  reconnectDelayMs: number | null;
  reconnected: boolean;
  state: BbRealtimeConnectionState;
}

export interface BbRealtimeEventMap {
  "thread:changed": ThreadRealtimeEvent;
  "project:changed": ProjectRealtimeEvent;
  "environment:changed": EnvironmentRealtimeEvent;
  "host:changed": HostRealtimeEvent;
  "system:changed": SystemRealtimeEvent;
  "system:config-changed": SystemRealtimeEvent;
  "realtime:connection": BbRealtimeConnectionEvent;
}

export type BbRealtimeCallback<TEventName extends BbRealtimeEventName> = (
  event: BbRealtimeEventMap[TEventName],
) => void;

export interface ThreadRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"thread:changed">;
  event: "thread:changed";
  threadId?: string;
}

export interface ProjectRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"project:changed">;
  event: "project:changed";
  projectId?: string;
}

export interface EnvironmentRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"environment:changed">;
  environmentId?: string;
  event: "environment:changed";
}

export interface HostRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"host:changed">;
  event: "host:changed";
  hostId?: string;
}

export interface SystemRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"system:changed">;
  event: "system:changed";
}

export interface SystemConfigRealtimeSubscribeArgs {
  callback: BbRealtimeCallback<"system:config-changed">;
  event: "system:config-changed";
}

export interface RealtimeConnectionSubscribeArgs {
  callback: BbRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

export type BbRealtimeSubscribeArgsUnion =
  | ThreadRealtimeSubscribeArgs
  | ProjectRealtimeSubscribeArgs
  | EnvironmentRealtimeSubscribeArgs
  | HostRealtimeSubscribeArgs
  | SystemRealtimeSubscribeArgs
  | SystemConfigRealtimeSubscribeArgs
  | RealtimeConnectionSubscribeArgs;

export type BbRealtimeSubscribeArgs<
  TEventName extends BbRealtimeEventName = BbRealtimeEventName,
> = Extract<BbRealtimeSubscribeArgsUnion, { event: TEventName }>;

export interface BbRealtime {
  subscribe<TEventName extends BbRealtimeEventName>(
    args: BbRealtimeSubscribeArgs<TEventName>,
  ): BbRealtimeUnsubscribe;
}
