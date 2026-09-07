import { useEffect, useState } from "react";
import { getProfileStore } from "@/lib/native";
import { resetLocalState, resetOnLaunch } from "./e2e";

export interface AppBootState {
  ready: boolean;
  error: string | null;
}

export function useAppBoot(): AppBootState {
  const [state, setState] = useState<AppBootState>({
    ready: false,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await getProfileStore().load();
      if (resetOnLaunch) await resetLocalState();
    })()
      .then(() => {
        if (!cancelled) setState({ ready: true, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            ready: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
