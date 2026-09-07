import { describe, expect, it, vi } from "vitest";
import {
  createConnectCredentialCache,
  type ConnectCredentialCacheFs,
  type ConnectCredentialEncryption,
} from "../src/connect-credential-cache.js";

const CREDENTIAL = {
  credential: "bbcm_desktop",
  handle: "laptop",
  serverUrl: "https://laptop.getbb.app",
};

function createEncryption(
  available = true,
): ConnectCredentialEncryption & { available: boolean } {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plainText) {
      return Buffer.from(`sealed:${plainText}`);
    },
    decryptString(encrypted) {
      const text = encrypted.toString();
      if (!text.startsWith("sealed:")) {
        throw new Error("cannot decrypt");
      }
      return text.slice("sealed:".length);
    },
  };
}

function createFs(seed: Buffer | null = null): ConnectCredentialCacheFs & {
  file: Buffer | null;
} {
  return {
    file: seed,
    async readFile() {
      if (this.file === null) {
        throw new Error("ENOENT");
      }
      return this.file;
    },
    async rm() {
      this.file = null;
    },
    async writeFile(_path, data) {
      this.file = data;
    },
  };
}

describe("createConnectCredentialCache", () => {
  it("round-trips a credential through the keychain", async () => {
    const fs = createFs();
    const cache = createConnectCredentialCache({
      encryption: createEncryption(),
      fs,
      userDataPath: "/data",
    });

    await cache.write(CREDENTIAL);
    expect(fs.file?.toString().startsWith("sealed:")).toBe(true);
    await expect(cache.read()).resolves.toEqual(CREDENTIAL);

    await cache.clear();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("never writes the secret when the OS offers no encryption", async () => {
    const fs = createFs();
    const encryption = createEncryption(false);
    const encryptString = vi.spyOn(encryption, "encryptString");

    const cache = createConnectCredentialCache({
      encryption,
      fs,
      userDataPath: "/data",
    });
    await cache.write(CREDENTIAL);

    expect(cache.canPersist()).toBe(false);
    expect(encryptString).not.toHaveBeenCalled();
    expect(fs.file).toBeNull();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("drops bytes it cannot decrypt or parse", async () => {
    const undecryptable = createFs(Buffer.from("from-another-machine"));
    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: undecryptable,
        userDataPath: "/data",
      }).read(),
    ).resolves.toBeNull();
    expect(undecryptable.file).toBeNull();

    const wrongShape = createFs(
      Buffer.from(`sealed:${JSON.stringify({ handle: "laptop" })}`),
    );
    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: wrongShape,
        userDataPath: "/data",
      }).read(),
    ).resolves.toBeNull();
    expect(wrongShape.file).toBeNull();
  });
});
