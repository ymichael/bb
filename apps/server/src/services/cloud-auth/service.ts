import {
  createCloudAuthAttemptId,
  deleteSandboxProviderCredentialByProviderId,
  getSandboxProviderCredentialByProviderId,
  listSandboxProviderCredentials,
  upsertSandboxProviderCredential,
  type DbConnection,
  type SandboxProviderCredentialRecord,
} from "@bb/db";
import type {
  CloudAuthAttemptResponse,
  CloudAuthConnectResponse,
  CloudAuthConnection,
  CloudAuthProviderId,
} from "@bb/server-contract";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "./callback-server.js";
import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  deserializeCloudAuthCredential,
  getCloudAuthConnectionLabel,
  getCloudAuthProviderDefinition,
  listCloudAuthProviderDefinitions,
  refreshStoredCloudAuthCredential,
  type CloudAuthResolvedCredential,
  type StoredCloudAuthCredential,
} from "@bb/agent-provider-auth";
import type {
  CloudAuthService,
} from "./types.js";
import type { ServerLogger } from "../../types.js";

const ATTEMPT_RETENTION_MS = 10 * 60_000;
const ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;

interface CreateCloudAuthServiceArgs {
  dataDir: string;
  db: DbConnection;
  logger: ServerLogger;
}

interface CloudAuthAttemptState {
  attempt: CloudAuthAttemptResponse;
  callbackServer: OAuthCallbackServer | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  expiresTimer: ReturnType<typeof setTimeout> | null;
}

interface PersistCredentialArgs {
  credential: StoredCloudAuthCredential;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  updatedAt: number;
}

function buildResolvedCredential(
  record: SandboxProviderCredentialRecord,
  credential: StoredCloudAuthCredential,
): CloudAuthResolvedCredential {
  return {
    credential,
    label: record.label,
    lastErrorMessage: record.lastErrorMessage,
    lastRefreshedAt: record.lastRefreshedAt,
    providerId: credential.providerId,
    updatedAt: record.updatedAt,
  };
}

function getProviderDefinition<TProviderId extends CloudAuthProviderId>(
  providerId: TProviderId,
) {
  return getCloudAuthProviderDefinition(providerId);
}

async function createAuthorizationFlow(
  providerId: CloudAuthProviderId,
): Promise<{
  authorizationUrl: string;
  state: string;
  verifier: string;
}> {
  return getProviderDefinition(providerId).createAuthorizationFlow();
}

function getCallbackConfig(providerId: CloudAuthProviderId): {
  errorTitle: string;
  listenHost: string;
  path: string;
  port: number;
  successTitle: string;
} {
  return getProviderDefinition(providerId).callback;
}

async function exchangeCode(
  providerId: CloudAuthProviderId,
  args: {
    code: string;
    state: string;
    verifier: string;
  },
): Promise<StoredCloudAuthCredential> {
  return getProviderDefinition(providerId).exchangeCode(args);
}

export async function createCloudAuthService(
  args: CreateCloudAuthServiceArgs,
): Promise<CloudAuthService> {
  const { dataDir, db, logger } = args;
  const crypto = await createCloudAuthCrypto({ dataDir });
  const refreshDeduper = createAsyncDeduper<
    CloudAuthProviderId,
    CloudAuthResolvedCredential
  >();
  const attemptsById = new Map<string, CloudAuthAttemptState>();
  const pendingAttemptIdsByProvider = new Map<CloudAuthProviderId, string>();

  function clearAttemptTimers(attemptState: CloudAuthAttemptState): void {
    if (attemptState.cleanupTimer) {
      clearTimeout(attemptState.cleanupTimer);
      attemptState.cleanupTimer = null;
    }
    if (attemptState.expiresTimer) {
      clearTimeout(attemptState.expiresTimer);
      attemptState.expiresTimer = null;
    }
  }

  function scheduleAttemptCleanup(attemptId: string): void {
    const attemptState = attemptsById.get(attemptId);
    if (!attemptState) {
      return;
    }

    if (attemptState.cleanupTimer) {
      clearTimeout(attemptState.cleanupTimer);
    }

    attemptState.cleanupTimer = setTimeout(() => {
      const current = attemptsById.get(attemptId);
      if (!current) {
        return;
      }
      void current.callbackServer?.close().catch(() => undefined);
      attemptsById.delete(attemptId);
    }, ATTEMPT_RETENTION_MS);
    attemptState.cleanupTimer.unref();
  }

  async function closeAttemptCallbackServer(attemptId: string): Promise<void> {
    const attemptState = attemptsById.get(attemptId);
    const callbackServer = attemptState?.callbackServer;
    if (!callbackServer) {
      return;
    }
    attemptState.callbackServer = null;
    await callbackServer.close().catch(() => undefined);
  }

  function finalizeAttempt(args: {
    attemptId: string;
    errorMessage: string | null;
    status: CloudAuthAttemptResponse["status"];
  }): void {
    const attemptState = attemptsById.get(args.attemptId);
    if (!attemptState) {
      return;
    }

    clearAttemptTimers(attemptState);
    attemptState.attempt = {
      ...attemptState.attempt,
      errorMessage: args.errorMessage,
      status: args.status,
    };

    if (pendingAttemptIdsByProvider.get(attemptState.attempt.providerId) === args.attemptId) {
      pendingAttemptIdsByProvider.delete(attemptState.attempt.providerId);
    }

    scheduleAttemptCleanup(args.attemptId);
  }

  async function persistCredential(persistArgs: PersistCredentialArgs): Promise<void> {
    upsertSandboxProviderCredential(db, buildCloudAuthCredentialUpsert({
      credential: persistArgs.credential,
      crypto,
      label: getCloudAuthConnectionLabel(persistArgs.credential),
      lastErrorMessage: persistArgs.lastErrorMessage,
      lastRefreshedAt: persistArgs.lastRefreshedAt,
      updatedAt: persistArgs.updatedAt,
    }));
  }

  function markCredentialErrored(argsMark: {
    errorMessage: string;
    record: SandboxProviderCredentialRecord;
    updatedAt: number;
  }): void {
    upsertSandboxProviderCredential(db, {
      encryptedAccessToken: argsMark.record.encryptedAccessToken,
      encryptedRefreshToken: argsMark.record.encryptedRefreshToken,
      encryptedIdToken: argsMark.record.encryptedIdToken,
      encryptedMetadata: argsMark.record.encryptedMetadata,
      expiresAt: argsMark.record.expiresAt,
      label: argsMark.record.label,
      lastErrorMessage: argsMark.errorMessage,
      lastRefreshedAt: argsMark.record.lastRefreshedAt,
      providerId: argsMark.record.providerId,
      updatedAt: argsMark.updatedAt,
    });
  }

  function readCredential(
    record: SandboxProviderCredentialRecord,
  ): StoredCloudAuthCredential {
    return deserializeCloudAuthCredential({
      crypto,
      record,
    });
  }

  async function getCredentialRecord(
    providerId: CloudAuthProviderId,
  ): Promise<SandboxProviderCredentialRecord | null> {
    return getSandboxProviderCredentialByProviderId(db, providerId);
  }

  async function getValidCredential(
    providerId: CloudAuthProviderId,
  ): Promise<CloudAuthResolvedCredential | null> {
    const record = await getCredentialRecord(providerId);
    if (!record) {
      return null;
    }

    let credential: StoredCloudAuthCredential;
    try {
      credential = readCredential(record);
    } catch (error) {
      markCredentialErrored({
        errorMessage:
          error instanceof Error ? error.message : "Failed to decrypt credential",
        record,
        updatedAt: Date.now(),
      });
      return null;
    }

    if (credential.expiresAt > Date.now() + REFRESH_SKEW_MS) {
      if (record.lastErrorMessage) {
        const updatedAt = Date.now();
        await persistCredential({
          credential,
          lastErrorMessage: null,
          lastRefreshedAt: record.lastRefreshedAt,
          updatedAt,
        });
        const refreshedRecord = await getCredentialRecord(providerId);
        if (refreshedRecord) {
          return buildResolvedCredential(refreshedRecord, credential);
        }
      }
      return buildResolvedCredential(record, credential);
    }

    return refreshDeduper.run(providerId, async () => {
      const currentRecord = await getCredentialRecord(providerId);
      if (!currentRecord) {
        throw new Error(`Missing credential for ${providerId}`);
      }

      const currentCredential = readCredential(currentRecord);
      if (currentCredential.expiresAt > Date.now() + REFRESH_SKEW_MS) {
        return buildResolvedCredential(currentRecord, currentCredential);
      }

      try {
        const refreshedCredential = await refreshStoredCloudAuthCredential({
          credential: currentCredential,
        });
        const updatedAt = Date.now();
        await persistCredential({
          credential: refreshedCredential,
          lastErrorMessage: null,
          lastRefreshedAt: updatedAt,
          updatedAt,
        });
        const refreshedRecord = await getCredentialRecord(providerId);
        if (!refreshedRecord) {
          throw new Error(`Missing credential for ${providerId} after refresh`);
        }
        return buildResolvedCredential(refreshedRecord, refreshedCredential);
      } catch (error) {
        markCredentialErrored({
          errorMessage:
            error instanceof Error ? error.message : "Credential refresh failed",
          record: currentRecord,
          updatedAt: Date.now(),
        });
        logger.warn(
          {
            err: error,
            providerId,
          },
          "Failed to refresh sandbox provider credential",
        );
        return buildResolvedCredential(currentRecord, currentCredential);
      }
    });
  }

  async function startConnection(
    providerId: CloudAuthProviderId,
  ): Promise<CloudAuthConnectResponse> {
    const previousAttemptId = pendingAttemptIdsByProvider.get(providerId);
    if (previousAttemptId) {
      finalizeAttempt({
        attemptId: previousAttemptId,
        errorMessage: "Superseded by a newer connection attempt",
        status: "expired",
      });
      await closeAttemptCallbackServer(previousAttemptId);
    }

    const flow = await createAuthorizationFlow(providerId);
    const callback = getCallbackConfig(providerId);
    const callbackServer = await startOAuthCallbackServer({
      errorTitle: callback.errorTitle,
      expectedState: flow.state,
      listenHost: callback.listenHost,
      path: callback.path,
      port: callback.port,
      successTitle: callback.successTitle,
    });
    const attemptId = createCloudAuthAttemptId();
    const attemptState: CloudAuthAttemptState = {
      attempt: {
        attemptId,
        errorMessage: null,
        providerId,
        status: "pending",
      },
      callbackServer,
      cleanupTimer: null,
      expiresTimer: null,
    };
    attemptsById.set(attemptId, attemptState);
    pendingAttemptIdsByProvider.set(providerId, attemptId);

    attemptState.expiresTimer = setTimeout(() => {
      const currentAttempt = attemptsById.get(attemptId);
      if (!currentAttempt || currentAttempt.attempt.status !== "pending") {
        return;
      }
      currentAttempt.callbackServer?.cancelWait();
      finalizeAttempt({
        attemptId,
        errorMessage: "The connection attempt timed out before the provider redirected back.",
        status: "expired",
      });
      void closeAttemptCallbackServer(attemptId);
    }, ATTEMPT_TIMEOUT_MS);
    attemptState.expiresTimer.unref();

    void callbackServer.waitForCode()
      .then(async (callbackPayload) => {
        if (!callbackPayload) {
          return;
        }
        const currentAttempt = attemptsById.get(attemptId);
        if (!currentAttempt || currentAttempt.attempt.status !== "pending") {
          return;
        }

        const credential = await exchangeCode(providerId, {
          code: callbackPayload.code,
          state: callbackPayload.state,
          verifier: flow.verifier,
        });
        const updatedAt = Date.now();
        await persistCredential({
          credential,
          lastErrorMessage: null,
          lastRefreshedAt: updatedAt,
          updatedAt,
        });
        finalizeAttempt({
          attemptId,
          errorMessage: null,
          status: "completed",
        });
      })
      .catch((error) => {
        finalizeAttempt({
          attemptId,
          errorMessage:
            error instanceof Error ? error.message : "Cloud auth exchange failed",
          status: "failed",
        });
      })
      .finally(() => closeAttemptCallbackServer(attemptId));

    return {
      attemptId,
      authorizationUrl: flow.authorizationUrl,
    };
  }

  async function listConnections(): Promise<CloudAuthConnection[]> {
    const recordsByProvider = new Map(
      listSandboxProviderCredentials(db).map((record) => [record.providerId, record]),
    );

    return listCloudAuthProviderDefinitions().map((provider) => {
      const record = recordsByProvider.get(provider.id);
      if (!record) {
        return {
          connectedAt: null,
          displayName: provider.displayName,
          errorMessage: null,
          expiresAt: null,
          label: null,
          lastRefreshedAt: null,
          providerId: provider.id,
          status: "missing",
        };
      }

      return {
        connectedAt: record.updatedAt,
        displayName: provider.displayName,
        errorMessage: record.lastErrorMessage,
        expiresAt: record.expiresAt,
        label: record.label,
        lastRefreshedAt: record.lastRefreshedAt,
        providerId: provider.id,
        status: record.lastErrorMessage ? "invalid" : "connected",
      };
    });
  }

  return {
    async disconnectProvider({ providerId }) {
      const pendingAttemptId = pendingAttemptIdsByProvider.get(providerId);
      if (pendingAttemptId) {
        finalizeAttempt({
          attemptId: pendingAttemptId,
          errorMessage: "Canceled by credential removal",
          status: "expired",
        });
        await closeAttemptCallbackServer(pendingAttemptId);
      }
      return deleteSandboxProviderCredentialByProviderId(db, providerId);
    },
    async dispose() {
      for (const [attemptId, attemptState] of attemptsById) {
        clearAttemptTimers(attemptState);
        await closeAttemptCallbackServer(attemptId);
        attemptsById.delete(attemptId);
      }
    },
    getAttempt({ attemptId }) {
      return attemptsById.get(attemptId)?.attempt ?? null;
    },
    async getValidCredential({ providerId }) {
      return getValidCredential(providerId);
    },
    async listConnections() {
      return listConnections();
    },
    async startConnection({ providerId }) {
      return startConnection(providerId);
    },
  };
}
