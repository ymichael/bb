import { atomWithStorage } from "jotai/utils";

type StringValueGuard<T extends string> = (value: string) => value is T;
type StoredValueGuard<T> = (value: unknown) => value is T;
type StoredValueListener = (storedValue: string | null) => void;

export interface SyncStorage<T> {
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

interface StoredValueCodec<T> {
  parse: (storedValue: string | null, initialValue: T) => T;
  serialize: (value: T) => string;
}

export function getLocalStorage(): Storage | null {
  return withLocalStorage((storage) => storage, null);
}

export function withLocalStorage<T>(
  operation: (storage: Storage) => T,
  fallback: T,
): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    return operation(window.localStorage);
  } catch {
    return fallback;
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage;
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
  getItem: (key: string) =>
    withLocalStorage((storage) => storage.getItem(key), null),
  setItem: (key: string, value: string) => {
    withLocalStorage((storage) => storage.setItem(key, value), undefined);
  },
  removeItem: (key: string) => {
    withLocalStorage((storage) => storage.removeItem(key), undefined);
  },
  subscribe: (key: string, callback: StoredValueListener) =>
    subscribeToLocalStorageKey(key, callback),
};

export const rawStringLocalStorage = createLocalStorageSyncStorage<string>({
  parse: (storedValue, initialValue) => storedValue ?? initialValue,
  serialize: (value) => value,
});

export function createJsonLocalStorage<T>(
  isValue?: StoredValueGuard<T>,
): SyncStorage<T> {
  return createLocalStorageSyncStorage<T>({
    parse: (storedValue, initialValue) => {
      if (storedValue === null) {
        return initialValue;
      }

      try {
        const parsedValue: unknown = JSON.parse(storedValue);
        return isValue === undefined || isValue(parsedValue)
          ? (parsedValue as T)
          : initialValue;
      } catch {
        return initialValue;
      }
    },
    serialize: (value) => JSON.stringify(value),
  });
}

export function createBooleanPreferenceAtom(
  storageKey: string,
  defaultValue: boolean,
) {
  return atomWithStorage<boolean>(
    storageKey,
    defaultValue,
    createJsonLocalStorage<boolean>(),
    { getOnInit: true },
  );
}

export function createTabScopedStorage<T>(
  codec: StoredValueCodec<T>,
): SyncStorage<T> {
  return {
    getItem: (key: string, initialValue: T) => {
      const tabValue = getSessionStorage()?.getItem(key) ?? null;
      const storedValue = tabValue ?? getLocalStorage()?.getItem(key) ?? null;
      return codec.parse(storedValue, initialValue);
    },
    setItem: (key: string, value: T) => {
      const serialized = codec.serialize(value);
      getSessionStorage()?.setItem(key, serialized);
      getLocalStorage()?.setItem(key, serialized);
    },
    removeItem: (key: string) => {
      getSessionStorage()?.removeItem(key);
      getLocalStorage()?.removeItem(key);
    },
  };
}

export function createLocalStorageSyncStorage<T>(
  codec: StoredValueCodec<T>,
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
    subscribe: (key: string, callback: (value: T) => void, initialValue: T) =>
      subscribeToLocalStorageKey(key, (storedValue) => {
        callback(codec.parse(storedValue, initialValue));
      }),
  };
}

export function createLocalStorageEnumStorage<T extends string>(
  isValue: StringValueGuard<T>,
): SyncStorage<T> {
  return createLocalStorageSyncStorage<T>({
    parse: (storedValue, initialValue) =>
      storedValue !== null && isValue(storedValue) ? storedValue : initialValue,
    serialize: (value) => value,
  });
}

export function createNullableLocalStorageEnumStorage<T extends string>(
  isValue: StringValueGuard<T>,
): SyncStorage<T | null> {
  return {
    getItem: (key: string, initialValue: T | null) => {
      const storedValue = localStorageStringStorage.getItem(key);
      return storedValue !== null && isValue(storedValue)
        ? storedValue
        : initialValue;
    },
    setItem: (key: string, value: T | null) => {
      if (value === null) {
        localStorageStringStorage.removeItem(key);
        return;
      }
      localStorageStringStorage.setItem(key, value);
    },
    removeItem: (key: string) => {
      localStorageStringStorage.removeItem(key);
    },
    subscribe: (
      key: string,
      callback: (value: T | null) => void,
      initialValue: T | null,
    ) =>
      subscribeToLocalStorageKey(key, (storedValue) => {
        callback(
          storedValue !== null && isValue(storedValue)
            ? storedValue
            : initialValue,
        );
      }),
  };
}
