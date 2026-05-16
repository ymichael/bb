import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { authApiKeys, authUsers, type DbConnection } from "@bb/db";
import { normalizeServerUrl } from "@bb/host-daemon-contract";
import { hostTypeSchema, type HostType } from "@bb/domain";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import { z } from "zod";
import type { ServerLogger } from "../types.js";

const AUTH_SECRET_FILE_NAME = "auth-secret";
const DAEMON_ENROLL_CONFIG_ID = "daemon-enroll";
const DAEMON_HOST_CONFIG_ID = "daemon-host";
const ENROLL_KEY_TTL_SECONDS = 60 * 15;
const MACHINE_AUTH_SYSTEM_USER_ID = "bb-machine-auth-system-user";
const MACHINE_AUTH_SYSTEM_USER_EMAIL = "machine-auth@bb.internal";
const MACHINE_AUTH_SYSTEM_USER_NAME = "Machine Auth System";

const machineAuthSchema = {
  apikey: authApiKeys,
  user: authUsers,
};

const machineCredentialMetadataSchema = z
  .object({
    hostId: z.string().min(1),
    hostType: hostTypeSchema,
  })
  .strict();

export type MachineCredentialMetadata = z.infer<
  typeof machineCredentialMetadataSchema
>;

export interface BuildJoinCommandArgs {
  hostId: string;
  hostType: HostType;
  joinCode: string;
  serverUrl: string;
}

export interface IssueHostEnrollKeyArgs {
  hostId: string;
  hostType: HostType;
}

export interface RevokeHostEnrollKeysArgs {
  hostId: string;
  hostType: HostType;
}

export interface IssueDaemonHostKeyArgs {
  hostId: string;
  hostType: HostType;
}

export interface RotateDaemonHostKeyArgs {
  keyId: string;
  hostId: string;
  hostType: HostType;
}

export interface DisableMachineKeyArgs {
  keyId: string;
}

export interface IssueHostEnrollKeyResult {
  expiresAt: number;
  key: string;
}

export interface EnrollHostArgs {
  hostId: string;
  hostType: HostType;
  token: string;
}

export interface EnrollHostResult {
  hostKey: string;
  metadata: MachineCredentialMetadata;
}

export interface VerifyMachineKeyResult {
  keyId: string;
  metadata: MachineCredentialMetadata;
}

interface CreateDaemonHostKeyResult {
  key: string;
  keyId: string;
}

export interface CreateMachineAuthServiceArgs {
  dataDir: string;
  db: DbConnection;
  logger: ServerLogger;
}

export interface MachineAuthService {
  buildJoinCommand(args: BuildJoinCommandArgs): string;
  disableMachineKey(args: DisableMachineKeyArgs): Promise<void>;
  ensureReady(): Promise<void>;
  enrollHost(args: EnrollHostArgs): Promise<EnrollHostResult | null>;
  issueDaemonHostKey(args: IssueDaemonHostKeyArgs): Promise<string>;
  issueHostEnrollKey(
    args: IssueHostEnrollKeyArgs,
  ): Promise<IssueHostEnrollKeyResult>;
  pruneExpiredKeys(): Promise<void>;
  revokeHostEnrollKeys(args: RevokeHostEnrollKeysArgs): Promise<void>;
  rotateDaemonHostKey(args: RotateDaemonHostKeyArgs): Promise<string>;
  verifyDaemonHostKey(token: string): Promise<VerifyMachineKeyResult | null>;
}

interface ApiKeyVerificationArgs {
  configId: string;
  token: string;
}

interface ApiKeyVerificationResult {
  keyId: string;
  metadata: MachineCredentialMetadata;
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

function parseCredentialMetadata(
  raw: unknown,
): MachineCredentialMetadata | null {
  const parsed = machineCredentialMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readOrCreateAuthSecret(dataDir: string): Promise<string> {
  return readOrCreateSecretFile({
    bytes: 32,
    dataDir,
    encoding: "hex",
    fileName: AUTH_SECRET_FILE_NAME,
  });
}

export async function createMachineAuthService(
  args: CreateMachineAuthServiceArgs,
): Promise<MachineAuthService> {
  const secret = await readOrCreateAuthSecret(args.dataDir);
  const auth = betterAuth({
    baseURL: "http://localhost",
    secret,
    database: drizzleAdapter(args.db, {
      provider: "sqlite",
      schema: machineAuthSchema,
    }),
    plugins: [
      apiKey([
        {
          configId: DAEMON_ENROLL_CONFIG_ID,
          defaultPrefix: "bbde_",
          enableMetadata: true,
          keyExpiration: {
            defaultExpiresIn: ENROLL_KEY_TTL_SECONDS * 1000,
          },
          references: "user",
          requireName: false,
        },
        {
          configId: DAEMON_HOST_CONFIG_ID,
          defaultPrefix: "bbdh_",
          enableMetadata: true,
          references: "user",
          requireName: false,
        },
      ]),
    ],
  });

  let readyPromise: Promise<void> | null = null;

  async function ensureSystemUser(): Promise<void> {
    const now = new Date();
    await args.db
      .insert(authUsers)
      .values({
        id: MACHINE_AUTH_SYSTEM_USER_ID,
        name: MACHINE_AUTH_SYSTEM_USER_NAME,
        email: MACHINE_AUTH_SYSTEM_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  async function ensureReady(): Promise<void> {
    if (!readyPromise) {
      readyPromise = ensureSystemUser().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }

    await readyPromise;
  }

  async function verifyKey(
    verifyArgs: ApiKeyVerificationArgs,
  ): Promise<ApiKeyVerificationResult | null> {
    await ensureReady();

    const result = await auth.api.verifyApiKey({
      body: {
        configId: verifyArgs.configId,
        key: verifyArgs.token,
      },
    });

    if (!result.valid || !result.key) {
      return null;
    }

    const metadata = parseCredentialMetadata(result.key.metadata);
    if (!metadata) {
      args.logger.warn(
        { configId: verifyArgs.configId, keyId: result.key.id },
        "Machine auth key metadata is missing required fields",
      );
      return null;
    }

    return {
      keyId: result.key.id,
      metadata,
    };
  }

  async function createDaemonHostKey(
    metadata: MachineCredentialMetadata,
  ): Promise<CreateDaemonHostKeyResult> {
    await ensureReady();

    const created = await auth.api.createApiKey({
      body: {
        configId: DAEMON_HOST_CONFIG_ID,
        metadata,
        rateLimitEnabled: false,
        userId: MACHINE_AUTH_SYSTEM_USER_ID,
      },
    });

    return {
      key: created.key,
      keyId: created.id,
    };
  }

  async function disableMachineKey(
    disableArgs: DisableMachineKeyArgs,
  ): Promise<void> {
    await ensureReady();
    await args.db
      .update(authApiKeys)
      .set({
        enabled: false,
        updatedAt: new Date(),
      })
      .where(eq(authApiKeys.id, disableArgs.keyId))
      .run();
  }

  async function disableActiveEnrollKeysForHost(
    metadata: MachineCredentialMetadata,
  ): Promise<void> {
    await ensureReady();
    await args.db
      .update(authApiKeys)
      .set({
        enabled: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(authApiKeys.configId, DAEMON_ENROLL_CONFIG_ID),
          eq(authApiKeys.enabled, true),
          sql`json_extract(${authApiKeys.metadata}, '$.hostId') = ${metadata.hostId}`,
          sql`json_extract(${authApiKeys.metadata}, '$.hostType') = ${metadata.hostType}`,
        ),
      )
      .run();
  }

  async function disableOtherActiveDaemonHostKeysForHost(
    metadata: MachineCredentialMetadata,
    preserveKeyId: string,
  ): Promise<void> {
    await ensureReady();
    await args.db
      .update(authApiKeys)
      .set({
        enabled: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(authApiKeys.configId, DAEMON_HOST_CONFIG_ID),
          eq(authApiKeys.enabled, true),
          ne(authApiKeys.id, preserveKeyId),
          sql`json_extract(${authApiKeys.metadata}, '$.hostId') = ${metadata.hostId}`,
          sql`json_extract(${authApiKeys.metadata}, '$.hostType') = ${metadata.hostType}`,
        ),
      )
      .run();
  }

  async function pruneExpiredKeys(): Promise<void> {
    await ensureReady();
    await args.db
      .delete(authApiKeys)
      .where(
        and(
          inArray(authApiKeys.configId, [
            DAEMON_ENROLL_CONFIG_ID,
            DAEMON_HOST_CONFIG_ID,
          ]),
          isNotNull(authApiKeys.expiresAt),
          lt(authApiKeys.expiresAt, new Date()),
        ),
      )
      .run();
  }

  return {
    buildJoinCommand({
      hostId,
      hostType,
      joinCode,
      serverUrl,
    }: BuildJoinCommandArgs): string {
      return [
        "npx bb-app",
        `--server-url ${quoteShellValue(normalizeServerUrl(serverUrl))}`,
        `--host-id ${quoteShellValue(hostId)}`,
        `--host-type ${quoteShellValue(hostType)}`,
        `--enroll-key ${quoteShellValue(joinCode)}`,
        "host-daemon",
      ].join(" ");
    },
    async disableMachineKey(disableArgs: DisableMachineKeyArgs): Promise<void> {
      await disableMachineKey(disableArgs);
    },
    async ensureReady(): Promise<void> {
      await ensureReady();
    },
    async enrollHost({
      hostId,
      hostType,
      token,
    }: EnrollHostArgs): Promise<EnrollHostResult | null> {
      const verified = await verifyKey({
        configId: DAEMON_ENROLL_CONFIG_ID,
        token,
      });
      if (!verified) {
        return null;
      }
      if (
        verified.metadata.hostId !== hostId ||
        verified.metadata.hostType !== hostType
      ) {
        return null;
      }

      // Create the replacement key before revoking prior daemon-host keys so
      // reenrollment does not strand the host if key creation fails mid-flow.
      const hostKey = await createDaemonHostKey(verified.metadata);
      await disableOtherActiveDaemonHostKeysForHost(
        verified.metadata,
        hostKey.keyId,
      );
      return {
        hostKey: hostKey.key,
        metadata: verified.metadata,
      };
    },
    async issueDaemonHostKey({
      hostId,
      hostType,
    }: IssueDaemonHostKeyArgs): Promise<string> {
      const created = await createDaemonHostKey({
        hostId,
        hostType,
      });
      return created.key;
    },
    async issueHostEnrollKey({
      hostId,
      hostType,
    }: IssueHostEnrollKeyArgs): Promise<IssueHostEnrollKeyResult> {
      await ensureReady();
      const metadata = {
        hostId,
        hostType,
      };
      await disableActiveEnrollKeysForHost(metadata);

      const created = await auth.api.createApiKey({
        body: {
          configId: DAEMON_ENROLL_CONFIG_ID,
          metadata,
          remaining: 1,
          rateLimitEnabled: false,
          userId: MACHINE_AUTH_SYSTEM_USER_ID,
        },
      });

      if (!created.expiresAt) {
        throw new Error("Machine enroll key is missing an expiration time");
      }

      return {
        expiresAt: created.expiresAt.getTime(),
        key: created.key,
      };
    },
    async pruneExpiredKeys(): Promise<void> {
      await pruneExpiredKeys();
    },
    async revokeHostEnrollKeys({
      hostId,
      hostType,
    }: RevokeHostEnrollKeysArgs): Promise<void> {
      await disableActiveEnrollKeysForHost({
        hostId,
        hostType,
      });
    },
    async rotateDaemonHostKey({
      keyId,
      hostId,
      hostType,
    }: RotateDaemonHostKeyArgs): Promise<string> {
      // Create the replacement key before revoking existing daemon-host keys so
      // host auth remains available if key creation fails mid-rotation.
      const nextHostKey = await createDaemonHostKey({
        hostId,
        hostType,
      });
      await disableOtherActiveDaemonHostKeysForHost(
        {
          hostId,
          hostType,
        },
        nextHostKey.keyId,
      );
      await disableMachineKey({ keyId });
      return nextHostKey.key;
    },
    async verifyDaemonHostKey(
      token: string,
    ): Promise<VerifyMachineKeyResult | null> {
      return verifyKey({
        configId: DAEMON_HOST_CONFIG_ID,
        token,
      });
    },
  };
}
