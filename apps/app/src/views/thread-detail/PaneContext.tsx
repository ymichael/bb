import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import type { SplitSide } from "@/lib/split-layout";

export interface PaneContextValue {
  paneId: string;
  isFocused: boolean;
  isSplitPane: boolean;
  secondaryPanelHost: PaneSecondaryPanelRegistration | null;
  reservesWindowPanelToggle: boolean;
  onRequestClose: (() => void) | null;
  isMaximized: boolean;
  onToggleMaximize: (() => void) | null;
  onMoveToSide?: (side: SplitSide) => void;
  isBoundedPane: boolean;
  isTopRow: boolean;
  ownsWindowTopLeft: boolean;
  navigateInPane: (thread: ThreadRoutePathArgs) => void;
  beginPaneDrag?: (event: ReactPointerEvent, label: string) => void;
}

export interface PaneSecondaryPanelViewModel {
  composerHost: PluginComposerHost | null;
  contentKey: string;
  isMainCollapsed: boolean;
  isOpen: boolean;
  panel: ReactNode;
  onToggle: () => void;
  transitionsReady: boolean;
}

export interface PaneSecondaryPanelRegistration {
  clear: () => void;
  publish: (model: PaneSecondaryPanelViewModel) => void;
}

type PaneSecondaryPanelRegistryListener = () => void;

export interface PaneSecondaryPanelRegistry {
  clear: (paneId: string) => void;
  getSnapshot: (paneId: string) => PaneSecondaryPanelViewModel | null;
  publish: (paneId: string, model: PaneSecondaryPanelViewModel) => void;
  subscribe: (
    paneId: string,
    listener: PaneSecondaryPanelRegistryListener,
  ) => () => void;
}

export function createPaneSecondaryPanelRegistry(): PaneSecondaryPanelRegistry {
  const models = new Map<string, PaneSecondaryPanelViewModel>();
  const listeners = new Map<string, Set<PaneSecondaryPanelRegistryListener>>();
  const notify = (paneId: string) => {
    listeners.get(paneId)?.forEach((listener) => listener());
  };

  return {
    clear: (paneId) => {
      if (!models.delete(paneId)) return;
      notify(paneId);
    },
    getSnapshot: (paneId) => models.get(paneId) ?? null,
    publish: (paneId, model) => {
      models.set(paneId, model);
      notify(paneId);
    },
    subscribe: (paneId, listener) => {
      const paneListeners = listeners.get(paneId) ?? new Set();
      paneListeners.add(listener);
      listeners.set(paneId, paneListeners);
      return () => {
        paneListeners.delete(listener);
        if (paneListeners.size === 0) listeners.delete(paneId);
      };
    },
  };
}

export function usePaneSecondaryPanelModel(
  registry: PaneSecondaryPanelRegistry,
  paneId: string,
): PaneSecondaryPanelViewModel | null {
  const subscribe = useCallback(
    (listener: PaneSecondaryPanelRegistryListener) =>
      registry.subscribe(paneId, listener),
    [paneId, registry],
  );
  const getSnapshot = useCallback(
    () => registry.getSnapshot(paneId),
    [paneId, registry],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePaneSecondaryPanelRegistration(
  registration: PaneSecondaryPanelRegistration | null,
  model: PaneSecondaryPanelViewModel,
): void {
  useLayoutEffect(() => {
    if (registration === null) return;
    registration.publish(model);
  }, [model, registration]);
  useLayoutEffect(
    () => (registration === null ? undefined : registration.clear),
    [registration],
  );
}

export const PaneContext = createContext<PaneContextValue | null>(null);

export function usePaneContext(): PaneContextValue {
  const context = useContext(PaneContext);
  if (context === null) {
    throw new Error("usePaneContext must be used within a <PaneContext>");
  }
  return context;
}

export function useOptionalPaneContext(): PaneContextValue | null {
  return useContext(PaneContext);
}

interface DefaultPaneContextProviderProps {
  children: ReactNode;
}

export function DefaultPaneContextProvider({
  children,
}: DefaultPaneContextProviderProps) {
  const navigate = useNavigate();
  const navigateInPane = useCallback(
    (thread: ThreadRoutePathArgs) => {
      navigate(getThreadRoutePath(thread));
    },
    [navigate],
  );
  const value = useMemo<PaneContextValue>(
    () => ({
      paneId: "main",
      isFocused: true,
      isSplitPane: false,
      secondaryPanelHost: null,
      reservesWindowPanelToggle: false,
      onRequestClose: null,
      isMaximized: false,
      onToggleMaximize: null,
      isBoundedPane: false,
      isTopRow: true,
      ownsWindowTopLeft: true,
      navigateInPane,
    }),
    [navigateInPane],
  );

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}
