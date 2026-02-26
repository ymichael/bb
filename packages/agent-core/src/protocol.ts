export type RealtimeEntity = "thread";

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
export interface ChangedMessage {
  type: "changed";
  entity: RealtimeEntity;
  id?: string;
}

export type ServerMessage = ChangedMessage;
