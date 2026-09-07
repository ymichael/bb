import { z } from "zod";
import {
  serverProfileSchema,
  type NewServerProfile,
  type ServerProfile,
  type ServerProfilePatch,
} from "./profile";
import {
  SECURE_STORAGE_MAX_VALUE_BYTES,
  utf8ByteLength,
  type SecureStorageLike,
} from "./secure-storage";

export const PROFILE_INDEX_STORAGE_KEY = "bb.profiles.index";
const PROFILE_STORAGE_KEY_PREFIX = "bb.profile.";

export function profileStorageKey(profileId: string): string {
  return `${PROFILE_STORAGE_KEY_PREFIX}${profileId}`;
}

const profileIndexSchema = z.object({
  ids: z.array(z.string().min(1)),
  activeProfileId: z.string().min(1).nullable(),
});
type ProfileIndex = z.infer<typeof profileIndexSchema>;

export type ProfileStoreStatus = "idle" | "loading" | "ready";

export interface ProfileStoreState {
  status: ProfileStoreStatus;
  profiles: readonly ServerProfile[];
  activeProfileId: string | null;
  loadError: string | null;
}

export interface ProfileStore {
  load(): Promise<ProfileStoreState>;
  getSnapshot(): ProfileStoreState;
  subscribe(listener: () => void): () => void;
  listProfiles(): readonly ServerProfile[];
  getActiveProfile(): ServerProfile | null;
  addProfile(input: NewServerProfile): Promise<ServerProfile>;
  updateProfile(id: string, patch: ServerProfilePatch): Promise<ServerProfile>;
  removeProfile(id: string): Promise<void>;
  setActiveProfile(id: string | null): Promise<void>;
}

export interface CreateProfileStoreDeps {
  storage: SecureStorageLike;
  now?: () => number;
  generateId?: () => string;
}

function defaultGenerateId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

function serializeProfile(profile: ServerProfile): string {
  const json = JSON.stringify(profile);
  const bytes = utf8ByteLength(json);
  if (bytes > SECURE_STORAGE_MAX_VALUE_BYTES) {
    throw new Error(
      `Profile "${profile.label}" is too large to store securely (${bytes} bytes > ${SECURE_STORAGE_MAX_VALUE_BYTES}).`,
    );
  }
  return json;
}

function parseIndex(raw: string | null): ProfileIndex {
  if (raw === null) return { ids: [], activeProfileId: null };
  try {
    const parsed = profileIndexSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  return { ids: [], activeProfileId: null };
}

function parseProfile(raw: string | null): ServerProfile | null {
  if (raw === null) return null;
  try {
    const parsed = serverProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createProfileStore(deps: CreateProfileStoreDeps): ProfileStore {
  const { storage } = deps;
  const now = deps.now ?? Date.now;
  const generateId = deps.generateId ?? defaultGenerateId;
  const listeners = new Set<() => void>();
  let state: ProfileStoreState = {
    status: "idle",
    profiles: [],
    activeProfileId: null,
    loadError: null,
  };
  let loadPromise: Promise<ProfileStoreState> | null = null;
  let mutationChain: Promise<unknown> = Promise.resolve();

  function setState(next: ProfileStoreState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  async function writeIndex(index: ProfileIndex): Promise<void> {
    await storage.setItem(PROFILE_INDEX_STORAGE_KEY, JSON.stringify(index));
  }

  function currentIndex(): ProfileIndex {
    return {
      ids: state.profiles.map((p) => p.id),
      activeProfileId: state.activeProfileId,
    };
  }

  async function doLoad(): Promise<ProfileStoreState> {
    setState({ ...state, status: "loading" });
    const index = parseIndex(await storage.getItem(PROFILE_INDEX_STORAGE_KEY));
    const profiles: ServerProfile[] = [];
    let loadError: string | null = null;
    for (const id of index.ids) {
      const profile = parseProfile(
        await storage.getItem(profileStorageKey(id)),
      );
      if (profile && profile.id === id) {
        profiles.push(profile);
      } else {
        loadError = `Saved server ${id} could not be read and was skipped.`;
      }
    }
    const activeProfileId =
      index.activeProfileId !== null &&
      profiles.some((p) => p.id === index.activeProfileId)
        ? index.activeProfileId
        : (profiles[0]?.id ?? null);
    setState({ status: "ready", profiles, activeProfileId, loadError });
    if (
      profiles.length !== index.ids.length ||
      activeProfileId !== index.activeProfileId
    ) {
      await writeIndex({ ids: profiles.map((p) => p.id), activeProfileId });
    }
    return state;
  }

  function load(): Promise<ProfileStoreState> {
    if (state.status === "ready") return Promise.resolve(state);
    if (!loadPromise) {
      loadPromise = doLoad().finally(() => {
        loadPromise = null;
      });
    }
    return loadPromise;
  }

  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(load).then(fn);
    mutationChain = run.catch(() => undefined);
    return run;
  }

  return {
    load,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listProfiles: () => state.profiles,
    getActiveProfile: () =>
      state.profiles.find((p) => p.id === state.activeProfileId) ?? null,

    addProfile(input) {
      return mutate(async () => {
        const profile = serverProfileSchema.parse({
          ...input,
          id: generateId(),
          createdAt: now(),
        });
        const json = serializeProfile(profile);
        await storage.setItem(profileStorageKey(profile.id), json);
        const profiles = [...state.profiles, profile];
        const activeProfileId = state.activeProfileId ?? profile.id;
        await writeIndex({ ids: profiles.map((p) => p.id), activeProfileId });
        setState({ ...state, profiles, activeProfileId });
        return profile;
      });
    },

    updateProfile(id, patch) {
      return mutate(async () => {
        const existing = state.profiles.find((p) => p.id === id);
        if (!existing) throw new Error(`Unknown server profile: ${id}`);
        if (
          existing.mode === "direct" &&
          (patch.handle !== undefined || patch.credential !== undefined)
        ) {
          throw new Error("Direct profiles have no connect handle/credential");
        }
        const merged = { ...existing, ...withoutUndefined(patch) };
        const profile = serverProfileSchema.parse(merged);
        await storage.setItem(profileStorageKey(id), serializeProfile(profile));
        setState({
          ...state,
          profiles: state.profiles.map((p) => (p.id === id ? profile : p)),
        });
        return profile;
      });
    },

    removeProfile(id) {
      return mutate(async () => {
        if (!state.profiles.some((p) => p.id === id)) return;
        const profiles = state.profiles.filter((p) => p.id !== id);
        const activeProfileId =
          state.activeProfileId === id
            ? (profiles[0]?.id ?? null)
            : state.activeProfileId;
        await writeIndex({ ids: profiles.map((p) => p.id), activeProfileId });
        setState({ ...state, profiles, activeProfileId });
        await storage.deleteItem(profileStorageKey(id));
      });
    },

    setActiveProfile(id) {
      return mutate(async () => {
        if (id !== null && !state.profiles.some((p) => p.id === id)) {
          throw new Error(`Unknown server profile: ${id}`);
        }
        if (id === state.activeProfileId) return;
        await writeIndex({ ...currentIndex(), activeProfileId: id });
        setState({ ...state, activeProfileId: id });
      });
    },
  };
}
