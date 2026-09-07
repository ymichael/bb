export interface SecureStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export const SECURE_STORAGE_MAX_VALUE_BYTES = 2048;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createMemorySecureStorage(
  initial: Record<string, string> = {},
): SecureStorageLike & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    async getItem(key) {
      return entries.get(key) ?? null;
    },
    async setItem(key, value) {
      if (utf8ByteLength(value) > SECURE_STORAGE_MAX_VALUE_BYTES) {
        throw new Error(
          `Secure storage value for "${key}" exceeds ${SECURE_STORAGE_MAX_VALUE_BYTES} bytes`,
        );
      }
      entries.set(key, value);
    },
    async deleteItem(key) {
      entries.delete(key);
    },
  };
}
