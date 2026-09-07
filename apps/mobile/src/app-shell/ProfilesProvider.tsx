import {
  QueryClientProvider,
  focusManager,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ActiveProfileConnection } from "@/lib/connection";
import { getProfileStore, nativeAppState } from "@/lib/native";
import {
  useProfileStoreState,
  type NewServerProfile,
  type ProfileStoreStatus,
  type ServerProfile,
  type ServerProfilePatch,
} from "@/lib/profiles";
import { installAppStateQueryEvents } from "@/lib/query/app-state-query-events";
import { createProfileQueryClient } from "@/lib/query/query-client";
import type { ProfileClient } from "@/lib/sdk";
import { getAppProfileClientRegistry } from "./client-registry";
import { getActiveProfileConnector } from "./connector";

export interface ProfilesContextValue {
  status: ProfileStoreStatus;
  profiles: readonly ServerProfile[];
  activeProfile: ServerProfile | null;
  loadError: string | null;
  connection: ActiveProfileConnection | null;
  addProfile(input: NewServerProfile): Promise<ServerProfile>;
  updateProfile(id: string, patch: ServerProfilePatch): Promise<ServerProfile>;
  removeProfile(id: string): Promise<void>;
  setActiveProfile(id: string): Promise<void>;
}

const ProfilesContext = createContext<ProfilesContextValue | null>(null);

let placeholderQueryClient: QueryClient | null = null;
function getPlaceholderQueryClient(): QueryClient {
  placeholderQueryClient ??= createProfileQueryClient();
  return placeholderQueryClient;
}

export function ProfilesProvider({ children }: { children: ReactNode }) {
  const store = getProfileStore();
  const connector = getActiveProfileConnector();
  const storeState = useProfileStoreState(store);
  const connection = useSyncExternalStore(
    connector.subscribe,
    connector.getSnapshot,
    connector.getSnapshot,
  );

  const activeProfile = useMemo(
    () =>
      storeState.profiles.find((p) => p.id === storeState.activeProfileId) ??
      null,
    [storeState.profiles, storeState.activeProfileId],
  );

  useEffect(
    () =>
      installAppStateQueryEvents({ AppState: nativeAppState, focusManager }),
    [],
  );

  useEffect(() => {
    if (storeState.status !== "ready") return;
    connector.activate(activeProfile);
  }, [connector, storeState.status, activeProfile]);

  const value = useMemo<ProfilesContextValue>(
    () => ({
      status: storeState.status,
      profiles: storeState.profiles,
      activeProfile,
      loadError: storeState.loadError,
      connection,
      addProfile: (input) => store.addProfile(input),
      updateProfile: (id, patch) => store.updateProfile(id, patch),
      async removeProfile(id) {
        await store.removeProfile(id);
        getAppProfileClientRegistry().disposeClient(id);
      },
      setActiveProfile: (id) => store.setActiveProfile(id),
    }),
    [store, storeState, activeProfile, connection],
  );

  return (
    <ProfilesContext.Provider value={value}>
      <QueryClientProvider
        client={connection?.client.queryClient ?? getPlaceholderQueryClient()}
      >
        {children}
      </QueryClientProvider>
    </ProfilesContext.Provider>
  );
}

export function useProfiles(): ProfilesContextValue {
  const value = useContext(ProfilesContext);
  if (!value) {
    throw new Error("useProfiles must be used inside <ProfilesProvider>");
  }
  return value;
}

export function useProfileClient(): ProfileClient {
  const { connection } = useProfiles();
  if (!connection) {
    throw new Error("useProfileClient requires an active server profile");
  }
  return connection.client;
}
