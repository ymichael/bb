import {
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  useContext,
} from "react";
import type { BbNavigate } from "@get-bb/plugin-sdk";

export type PluginThreadPanelOpenHandler = (
  options: Parameters<BbNavigate["openThreadPanel"]>[0] & {
    pluginId: string;
  },
) => boolean;

const PluginThreadPanelNavigationContext =
  createContext<PluginThreadPanelOpenHandler | null>(null);

export function PluginThreadPanelNavigationProvider({
  children,
  openThreadPanel,
}: {
  children: ReactNode;
  openThreadPanel: PluginThreadPanelOpenHandler;
}) {
  return (
    <PluginThreadPanelNavigationContext.Provider value={openThreadPanel}>
      {children}
    </PluginThreadPanelNavigationContext.Provider>
  );
}

export function usePluginThreadPanelOpenHandler(): PluginThreadPanelOpenHandler | null {
  return useContext(PluginThreadPanelNavigationContext);
}

const focusedOpeners = new Map<symbol, PluginThreadPanelOpenHandler>();

export function usePublishThreadPanelOpener(
  openThreadPanel: PluginThreadPanelOpenHandler,
  isActive: boolean,
): void {
  const handlerRef = useRef(openThreadPanel);
  useLayoutEffect(() => {
    handlerRef.current = openThreadPanel;
  }, [openThreadPanel]);
  const tokenRef = useRef<symbol | null>(null);
  tokenRef.current ??= Symbol("thread-panel-opener");
  useEffect(() => {
    const token = tokenRef.current;
    if (token === null || !isActive) return;
    focusedOpeners.set(token, (options) => handlerRef.current(options));
    return () => {
      focusedOpeners.delete(token);
    };
  }, [isActive]);
}

export function getActiveThreadPanelOpener(): PluginThreadPanelOpenHandler | null {
  let active: PluginThreadPanelOpenHandler | null = null;
  for (const opener of focusedOpeners.values()) active = opener;
  return active;
}

export function resetActiveThreadPanelOpenerForTest(): void {
  focusedOpeners.clear();
}
