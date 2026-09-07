import { connectCredentialSchema } from "@bb/connect-client";
import type { ConnectCredential } from "@bb/connect-client";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

export const CREDENTIAL_KV_KEY = "credential";

export interface CredentialStore {
  read(): Promise<ConnectCredential | null>;
  write(value: ConnectCredential): Promise<void>;
  clear(): Promise<void>;
}

export function createKvCredentialStore(
  kv: Pick<PluginKvStorage, "get" | "set" | "delete">,
): CredentialStore {
  return {
    async read() {
      const raw = await kv.get<unknown>(CREDENTIAL_KV_KEY);
      if (raw === undefined) return null;
      const parsed = connectCredentialSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async write(value) {
      await kv.set(CREDENTIAL_KV_KEY, value);
    },
    async clear() {
      await kv.delete(CREDENTIAL_KV_KEY);
    },
  };
}
