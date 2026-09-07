import type { ParcelWatcherSubscribeOptions } from "../parcel-watcher-backend.js";

export interface SerializedParcelEvent {
  path: string;
  type: "create" | "update" | "delete";
}

export type ParentToChildMessage =
  | {
      kind: "subscribe";
      id: string;
      dir: string;
      opts?: ParcelWatcherSubscribeOptions;
      rescan?: boolean;
    }
  | { kind: "unsubscribe"; id: string }
  | { kind: "ping"; nonce: number };

export type ChildToParentMessage =
  | { kind: "ready" }
  | { kind: "pong"; nonce: number }
  | { kind: "subscribed"; id: string }
  | { kind: "subscribe-failed"; id: string; message: string }
  | { kind: "unsubscribed"; id: string }
  | { kind: "events"; id: string; events: SerializedParcelEvent[] }
  | {
      kind: "watch-error";
      id: string;
      message: string;
      recovery: "rescan-subscription" | "recycle-child";
    };
