import { atomFamily, atomWithStorage } from "jotai/utils";
import { getProjectScopedStorageKey } from "./project-scoped-storage";

type ProjectScopedStorageParam = string | null | undefined;
type StoredValueListener = (storedValue: string | null) => void;

interface SyncStorage<T> {
  getItem: (key: string, initialValue: T) => T;
  setItem: (key: string, newValue: T) => void;
  removeItem: (key: string) => void;
  subscribe?: (
    key: string,
    callback: (value: T) => void,
    initialValue: T,
  ) => (() => void) | undefined;
}

interface SyncStringStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, newValue: string) => void;
  removeItem: (key: string) => void;
  subscribe?: (
    key: string,
    callback: StoredValueListener,
  ) => (() => void) | undefined;
}

interface LocalStorageValueCodec<T> {
  parse: (storedValue: string | null, initialValue: T) => T;
  serialize: (value: T) => string;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function subscribeToLocalStorageKey(
  key: string,
  callback: StoredValueListener,
): () => void {
  const localStorage = getLocalStorage();
  if (
    !localStorage ||
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && event.key === key) {
      callback(event.newValue);
    }
  };

  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("storage", handleStorage);
  };
}

const localStorageStringStorage: SyncStringStorage = {
  getItem: (key: string) => getLocalStorage()?.getItem(key) ?? null,
  setItem: (key: string, value: string) => {
    getLocalStorage()?.setItem(key, value);
  },
  removeItem: (key: string) => {
    getLocalStorage()?.removeItem(key);
  },
  subscribe: (key: string, callback: StoredValueListener) =>
    subscribeToLocalStorageKey(key, callback),
};

export const rawStringLocalStorage = createLocalStorageSyncStorage<string>({
  parse: (storedValue, initialValue) => storedValue ?? initialValue,
  serialize: (value) => value,
});

export function createJsonLocalStorage<T>(): SyncStorage<T> {
  return createLocalStorageSyncStorage<T>({
    parse: (storedValue, initialValue) => {
      if (storedValue === null) {
        return initialValue;
      }

      try {
        return JSON.parse(storedValue) as T;
      } catch {
        return initialValue;
      }
    },
    serialize: (value) => JSON.stringify(value),
  });
}

export function createLocalStorageSyncStorage<T>(
  codec: LocalStorageValueCodec<T>,
): SyncStorage<T> {
  return {
    getItem: (key: string, initialValue: T) =>
      codec.parse(localStorageStringStorage.getItem(key), initialValue),
    setItem: (key: string, value: T) => {
      localStorageStringStorage.setItem(key, codec.serialize(value));
    },
    removeItem: (key: string) => {
      localStorageStringStorage.removeItem(key);
    },
    subscribe: (
      key: string,
      callback: (value: T) => void,
      initialValue: T,
    ) =>
      subscribeToLocalStorageKey(key, (storedValue) => {
        callback(codec.parse(storedValue, initialValue));
      }),
  };
}

export function createLocalStorageEnumStorage<T extends string>(
  isValue: (value: string) => value is T,
): SyncStorage<T> {
  return createLocalStorageSyncStorage<T>({
    parse: (storedValue, initialValue) =>
      storedValue !== null && isValue(storedValue) ? storedValue : initialValue,
    serialize: (value) => value,
  });
}

export function createProjectScopedStorageAtomFamily<T>(
  baseKey: string,
  initialValue: T,
  storage: SyncStorage<T>,
) {
  return atomFamily((projectId: ProjectScopedStorageParam) =>
    atomWithStorage<T>(
      getProjectScopedStorageKey(baseKey, projectId),
      initialValue,
      storage,
      { getOnInit: true },
    )
  );
}
