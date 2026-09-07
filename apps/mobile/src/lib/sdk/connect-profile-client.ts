import {
  bindRealtimeToAppState,
  type AppStateLike,
} from "../realtime/app-state";
import type { ProfileClient } from "./client-registry";

export function connectProfileClient(
  client: ProfileClient,
  appState: AppStateLike,
): () => void {
  client.realtime.connect();
  const unbind = bindRealtimeToAppState(client.realtime, appState);
  return () => {
    unbind();
    client.realtime.disconnect();
  };
}
