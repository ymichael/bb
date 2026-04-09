import {
  createEncryptedJsonCrypto,
  type EncryptedJsonCrypto,
} from "@bb/secret-storage";

const CLOUD_AUTH_SECRET_FILE_NAME = "cloud-auth-secret";

export interface CreateCloudAuthCryptoArgs {
  dataDir: string;
}

export type CloudAuthCrypto = EncryptedJsonCrypto;

export async function createCloudAuthCrypto(
  args: CreateCloudAuthCryptoArgs,
): Promise<CloudAuthCrypto> {
  return createEncryptedJsonCrypto({
    dataDir: args.dataDir,
    fileName: CLOUD_AUTH_SECRET_FILE_NAME,
  });
}
