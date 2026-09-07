import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectCredentialSchema,
  type ConnectCredential,
} from "@bb/connect-client";

const CONNECT_CREDENTIAL_FILE_NAME = "connect-credential.bin";

export interface ConnectCredentialEncryption {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  isEncryptionAvailable(): boolean;
}

export interface ConnectCredentialCacheFs {
  readFile(path: string): Promise<Buffer>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

interface CreateConnectCredentialCacheArgs {
  encryption: ConnectCredentialEncryption;
  fs?: ConnectCredentialCacheFs;
  userDataPath: string;
}

export interface ConnectCredentialCache {
  canPersist(): boolean;
  clear(): Promise<void>;
  read(): Promise<ConnectCredential | null>;
  write(credential: ConnectCredential): Promise<void>;
}

const defaultFs: ConnectCredentialCacheFs = {
  readFile,
  rm,
  writeFile,
};

export function createConnectCredentialCache(
  args: CreateConnectCredentialCacheArgs,
): ConnectCredentialCache {
  const fsImpl = args.fs ?? defaultFs;
  const filePath = join(args.userDataPath, CONNECT_CREDENTIAL_FILE_NAME);

  async function clear(): Promise<void> {
    await fsImpl.rm(filePath, { force: true });
  }

  return {
    canPersist() {
      return args.encryption.isEncryptionAvailable();
    },
    clear,
    async read() {
      if (!args.encryption.isEncryptionAvailable()) {
        return null;
      }
      let encrypted: Buffer;
      try {
        encrypted = await fsImpl.readFile(filePath);
      } catch {
        return null;
      }
      let plainText: string;
      try {
        plainText = args.encryption.decryptString(encrypted);
      } catch {
        await clear();
        return null;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(plainText);
      } catch {
        await clear();
        return null;
      }
      const parsed = connectCredentialSchema.safeParse(parsedJson);
      if (!parsed.success) {
        await clear();
        return null;
      }
      return parsed.data;
    },
    async write(credential) {
      if (!args.encryption.isEncryptionAvailable()) {
        return;
      }
      await fsImpl.writeFile(
        filePath,
        args.encryption.encryptString(JSON.stringify(credential)),
      );
    },
  };
}
