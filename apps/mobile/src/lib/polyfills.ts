import { getRandomValues } from "expo-crypto";

type CryptoLike = { getRandomValues?: unknown };

const globalCrypto = (globalThis as { crypto?: CryptoLike }).crypto;
if (!globalCrypto) {
  (globalThis as { crypto?: CryptoLike }).crypto = { getRandomValues };
} else if (typeof globalCrypto.getRandomValues !== "function") {
  globalCrypto.getRandomValues = getRandomValues;
}
