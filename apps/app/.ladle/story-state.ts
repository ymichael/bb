import { useEffect } from "react";
import { useStore, type Store } from "jotai";
import type { WebSocketConnectionState } from "../src/lib/ws";

export type StoryStateSeed = (store: Store) => void;

export interface SeedWebSocketAtomsArgs {
  status: WebSocketConnectionState;
}

export function useSeed(seed: StoryStateSeed): void {
  const store = useStore();

  useEffect(() => {
    seed(store);
  }, [seed, store]);
}

export function seedWebSocketAtoms(
  _args: SeedWebSocketAtomsArgs,
): StoryStateSeed {
  return () => {
    // WebSocket connection state is manager-owned today. Keep this helper as
    // the story boundary so future atom-backed state does not change stories.
  };
}
