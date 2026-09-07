import { createContext, useContext, type ReactNode } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type {
  AppFixedTabOpenIntent,
  AppFixedTabReference,
} from "@/lib/app-navigation-host";

export interface AppFixedTabDestination {
  open(target: JsonValue | undefined): boolean;
  tab: AppFixedTabReference;
}

export function getPluginFixedTabOwnerId(
  pluginId: string,
  panelId: string,
): string {
  return `plugin:${pluginId}:${panelId}`;
}

export function openAppFixedTabFromDestinations(
  destinations: readonly AppFixedTabDestination[],
  intent: AppFixedTabOpenIntent,
): boolean {
  const destination = destinations.find(
    (candidate) =>
      candidate.tab.ownerId === intent.tab.ownerId &&
      candidate.tab.tabId === intent.tab.tabId,
  );
  return destination?.open(intent.target) ?? false;
}

interface AppFixedTabTargetSnapshot {
  ownerId: string;
  sequence: number;
  tabId: string;
  target: JsonValue;
}

export interface AppFixedTabTargetState extends AppFixedTabTargetSnapshot {
  clear(): void;
}

const AppFixedTabTargetContext = createContext<AppFixedTabTargetState | null>(
  null,
);

export function AppFixedTabTargetProvider({
  children,
  state,
}: {
  children: ReactNode;
  state: AppFixedTabTargetState | null;
}) {
  return (
    <AppFixedTabTargetContext.Provider value={state}>
      {children}
    </AppFixedTabTargetContext.Provider>
  );
}

export function useAppFixedTabTarget(
  ownerId: string,
  tabId: string,
): AppFixedTabTargetState | null {
  const state = useContext(AppFixedTabTargetContext);
  return state?.ownerId === ownerId && state.tabId === tabId ? state : null;
}
