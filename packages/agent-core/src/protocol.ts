export type RealtimeEntity = "thread" | "system";

export const THREAD_CHANGE_KINDS = [
  "thread-created",
  "thread-deleted",
  "events-appended",
  "status-changed",
  "title-changed",
  "queue-changed",
  "work-status-changed",
  "archived-changed",
  "read-state-changed",
] as const;

export type ThreadChangeKind = (typeof THREAD_CHANGE_KINDS)[number];

export const SYSTEM_CHANGE_KINDS = [
  "restart-policy-changed",
] as const;

export type SystemChangeKind = (typeof SYSTEM_CHANGE_KINDS)[number];

// Client -> Server
export interface SubscribeMessage {
  type: "subscribe";
  entity: RealtimeEntity;
  id?: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  entity: RealtimeEntity;
  id?: string;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage;

// Server -> Client
export interface ThreadChangedMessage {
  type: "changed";
  entity: "thread";
  id?: string;
  changes: ThreadChangeKind[];
}

export interface SystemChangedMessage {
  type: "changed";
  entity: "system";
  changes: SystemChangeKind[];
}

export type ChangedMessage = ThreadChangedMessage | SystemChangedMessage;

export type ServerMessage = ChangedMessage;
