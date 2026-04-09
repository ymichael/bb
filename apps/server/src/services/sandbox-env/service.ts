import {
  deleteAppSandboxEnvVar,
  listAppSandboxEnvVars,
  upsertAppSandboxEnvVar,
  type DbConnection,
} from "@bb/db";
import { z } from "zod";
import {
  createEncryptedJsonCrypto,
  type EncryptedJsonCrypto,
} from "../lib/encrypted-json-crypto.js";
import type { ServerLogger } from "../../types.js";
import type {
  SandboxEnvService,
  UpsertSandboxEnvVarArgs,
} from "./types.js";

const SANDBOX_ENV_SECRET_FILE_NAME = "sandbox-env-secret";

interface CreateSandboxEnvServiceArgs {
  dataDir: string;
  db: DbConnection;
  logger: ServerLogger;
}

function toSandboxEnvVar(
  record: Awaited<ReturnType<typeof listAppSandboxEnvVars>>[number],
) {
  return {
    createdAt: record.createdAt,
    name: record.name,
    updatedAt: record.updatedAt,
  };
}

function decryptEnvValue(
  crypto: EncryptedJsonCrypto,
  encryptedValue: string,
): string {
  return crypto.decryptJson({
    payload: encryptedValue,
    schema: z.string(),
  });
}

export async function createSandboxEnvService(
  args: CreateSandboxEnvServiceArgs,
): Promise<SandboxEnvService> {
  const crypto = await createEncryptedJsonCrypto({
    dataDir: args.dataDir,
    fileName: SANDBOX_ENV_SECRET_FILE_NAME,
  });

  async function upsertEnvVar(
    upsertArgs: UpsertSandboxEnvVarArgs,
  ) {
    return toSandboxEnvVar(
      upsertAppSandboxEnvVar(args.db, {
        encryptedValue: crypto.encryptJson({
          plaintext: JSON.stringify(upsertArgs.value),
        }),
        name: upsertArgs.name,
      }),
    );
  }

  return {
    async deleteEnvVar({ name }) {
      return deleteAppSandboxEnvVar(args.db, name);
    },
    async listEnvVars() {
      return listAppSandboxEnvVars(args.db).map(toSandboxEnvVar);
    },
    async resolveRuntimeEnv() {
      const runtimeEnv: Record<string, string> = {};

      for (const record of listAppSandboxEnvVars(args.db)) {
        try {
          runtimeEnv[record.name] = decryptEnvValue(
            crypto,
            record.encryptedValue,
          );
        } catch (error) {
          args.logger.warn(
            {
              envVarName: record.name,
              err: error,
            },
            "Failed to decrypt sandbox env var",
          );
        }
      }

      return runtimeEnv;
    },
    upsertEnvVar,
  };
}
