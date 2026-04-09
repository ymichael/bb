import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { readOrCreateSecretFile } from "./secret-file.js";

const CIPHER_ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH_BYTES = 16;

const encryptedPayloadEnvelopeSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  version: z.literal(1),
}).strict();

interface CreateEncryptedJsonCryptoArgs {
  dataDir: string;
  fileName: string;
}

interface DecryptJsonArgs<TValue> {
  payload: string;
  schema: z.ZodType<TValue>;
}

interface EncryptJsonArgs {
  plaintext: string;
}

export interface EncryptedJsonCrypto {
  decryptJson<TValue>(args: DecryptJsonArgs<TValue>): TValue;
  encryptJson(args: EncryptJsonArgs): string;
}

export async function createEncryptedJsonCrypto(
  args: CreateEncryptedJsonCryptoArgs,
): Promise<EncryptedJsonCrypto> {
  const encodedSecret = await readOrCreateSecretFile({
    bytes: 32,
    dataDir: args.dataDir,
    fileName: args.fileName,
  });
  const secret = Buffer.from(encodedSecret, "base64");

  if (secret.byteLength !== 32) {
    throw new Error("Encrypted JSON secret must decode to 32 bytes");
  }

  return {
    decryptJson({ payload, schema }) {
      const envelope = encryptedPayloadEnvelopeSchema.parse(JSON.parse(payload));
      const decipher = createDecipheriv(
        CIPHER_ALGORITHM,
        secret,
        Buffer.from(envelope.iv, "base64"),
        { authTagLength: AUTH_TAG_LENGTH_BYTES },
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return schema.parse(JSON.parse(plaintext));
    },
    encryptJson({ plaintext }) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(CIPHER_ALGORITHM, secret, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return JSON.stringify({
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        version: 1,
      });
    },
  };
}
