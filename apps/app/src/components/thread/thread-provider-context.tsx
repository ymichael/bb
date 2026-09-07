import { createContext, useContext } from "react";

export interface ThreadProviderContextValue {
  providerId: string | null;
  pluginId: string | null;
}

const UNKNOWN_THREAD_PROVIDER: ThreadProviderContextValue = {
  providerId: null,
  pluginId: null,
};

export const ThreadProviderContext = createContext<ThreadProviderContextValue>(
  UNKNOWN_THREAD_PROVIDER,
);

export function useThreadProvider(): ThreadProviderContextValue {
  return useContext(ThreadProviderContext);
}
