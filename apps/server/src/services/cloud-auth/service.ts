import {
  createCloudAuthAttemptId,
  deleteSandboxProviderCredentialByProviderId,
  getSandboxProviderCredentialByProviderId,
  listSandboxProviderCredentials,
  upsertSandboxProviderCredential,
  type DbConnection,
  type SandboxProviderCredentialRecord,
} from "@bb/db";
import type { CloudAuthProviderId } from "@bb/agent-providers";
import type {
  CloudAuthAttemptResponse,
  CloudAuthConnectResponse,
  CloudAuthConnection,
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
const DECRYPT_FAILURE_MESSAGE = "Failed to decrypt stored credential";
const MAX_ERROR_MESSAGE_LENGTH = 256;

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
  lastRefreshedAt: number | null;
  updatedAt: number;
}

interface ResolveCredentialRecordArgs {
  providerId: CloudAuthProviderId;
  record: SandboxProviderCredentialRecord;
}

interface UpdateCredentialErrorStateArgs {
  errorMessage: string;
  providerId: CloudAuthProviderId;
  updatedAt: number;
  whenRecordUpdatedAt: number;
}

function sanitizeCloudAuthErrorMessage(message: string): string {
  const sanitized = message.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (sanitized.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
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

export async function createCloudAuthService(
  args: CreateCloudAuthServiceArgs,
): Promise<CloudAuthService> {
  const { dataDir, db, logger } = args;
  const crypto = await createCloudAuthCrypto({ dataDir });
  const credentialResolutionDeduper = createAsyncDeduper<
    CloudAuthProviderId,
    CloudAuthResolvedCredential | null
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
    if (!attemptState || attemptState.callbackServer === null) {
      return;
    }
    const callbackServer = attemptState.callbackServer;
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
      errorMessage:
        args.errorMessage === null
          ? null
          : sanitizeCloudAuthErrorMessage(args.errorMessage),
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
      lastErrorMessage: null,
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

  function getCredentialRecord(
    providerId: CloudAuthProviderId,
  ): SandboxProviderCredentialRecord | null {
    return getSandboxProviderCredentialByProviderId(db, providerId);
  }

  function logDecryptFailure(
    providerId: CloudAuthProviderId,
    error: unknown,
  ): void {
    logger.warn(
      {
        errorMessage:
          error instanceof Error ? error.message : "Unknown decrypt failure",
        errorName: error instanceof Error ? error.name : "Error",
        providerId,
      },
      "Failed to decrypt sandbox provider credential",
    );
  }

  function updateCredentialErrorState(
    updateArgs: UpdateCredentialErrorStateArgs,
  ): SandboxProviderCredentialRecord | null {
    const currentRecord = getCredentialRecord(updateArgs.providerId);
    if (!currentRecord) {
      return null;
    }
    if (currentRecord.updatedAt !== updateArgs.whenRecordUpdatedAt) {
      return currentRecord;
    }
    if (currentRecord.lastErrorMessage === updateArgs.errorMessage) {
      return currentRecord;
    }

    markCredentialErrored({
      errorMessage: updateArgs.errorMessage,
      record: currentRecord,
      updatedAt: updateArgs.updatedAt,
    });
    return getCredentialRecord(updateArgs.providerId);
  }

  function resolveCredentialRecord(
    resolveArgs: ResolveCredentialRecordArgs,
  ): CloudAuthResolvedCredential | null {
    try {
      const credential = readCredential(resolveArgs.record);
      return buildResolvedCredential(resolveArgs.record, credential);
    } catch (error) {
      logDecryptFailure(resolveArgs.providerId, error);
      updateCredentialErrorState({
        errorMessage: DECRYPT_FAILURE_MESSAGE,
        providerId: resolveArgs.providerId,
        updatedAt: Date.now(),
        whenRecordUpdatedAt: resolveArgs.record.updatedAt,
      });
      return null;
    }
  }

  async function persistCredentialIfCurrent(argsPersist: {
    credential: StoredCloudAuthCredential;
    lastRefreshedAt: number | null;
    providerId: CloudAuthProviderId;
    updatedAt: number;
    whenRecordUpdatedAt: number;
  }): Promise<CloudAuthResolvedCredential | null> {
    const currentRecord = getCredentialRecord(argsPersist.providerId);
    if (!currentRecord) {
      return null;
    }
    if (currentRecord.updatedAt !== argsPersist.whenRecordUpdatedAt) {
      return resolveCredentialRecord({
        providerId: argsPersist.providerId,
        record: currentRecord,
      });
    }

    await persistCredential({
      credential: argsPersist.credential,
      lastRefreshedAt: argsPersist.lastRefreshedAt,
      updatedAt: argsPersist.updatedAt,
    });
    const persistedRecord = getCredentialRecord(argsPersist.providerId);
    if (!persistedRecord) {
      return null;
    }
    return buildResolvedCredential(persistedRecord, argsPersist.credential);
  }

  async function getValidCredential(
    providerId: CloudAuthProviderId,
  ): Promise<CloudAuthResolvedCredential | null> {
    return credentialResolutionDeduper.run(providerId, async () => {
      const currentRecord = getCredentialRecord(providerId);
      if (!currentRecord) {
        return null;
      }

      const currentResolvedCredential = resolveCredentialRecord({
        providerId,
        record: currentRecord,
      });
      if (!currentResolvedCredential) {
        return null;
      }
      const currentCredential = currentResolvedCredential.credential;
      if (currentCredential.expiresAt > Date.now() + REFRESH_SKEW_MS) {
        if (currentRecord.lastErrorMessage) {
          const updatedAt = Date.now();
          return persistCredentialIfCurrent({
            credential: currentCredential,
            lastRefreshedAt: currentRecord.lastRefreshedAt,
            providerId,
            updatedAt,
            whenRecordUpdatedAt: currentRecord.updatedAt,
          });
        }
        return currentResolvedCredential;
      }

      try {
        const refreshedCredential = await refreshStoredCloudAuthCredential({
          credential: currentCredential,
        });
        const updatedAt = Date.now();
        const persistedCredential = await persistCredentialIfCurrent({
          credential: refreshedCredential,
          lastRefreshedAt: updatedAt,
          providerId,
          updatedAt,
          whenRecordUpdatedAt: currentRecord.updatedAt,
        });
        if (!persistedCredential) {
          return null;
        }
        return persistedCredential;
      } catch (error) {
        updateCredentialErrorState({
          errorMessage: sanitizeCloudAuthErrorMessage(
            error instanceof Error ? error.message : "Credential refresh failed",
          ),
          providerId,
          updatedAt: Date.now(),
          whenRecordUpdatedAt: currentRecord.updatedAt,
        });
        logger.warn(
          {
            err: error,
            providerId,
          },
          "Failed to refresh sandbox provider credential",
        );
        const refreshedRecord = getCredentialRecord(providerId);
        if (!refreshedRecord) {
          return null;
        }
        return resolveCredentialRecord({
          providerId,
          record: refreshedRecord,
        });
      }
    });
  }

  async function startConnection(
    providerId: CloudAuthProviderId,
    appOrigin: string,
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

    const providerDefinition = getCloudAuthProviderDefinition(providerId);
    const flow = await providerDefinition.createAuthorizationFlow();
    const callback = providerDefinition.callback;
    const callbackServer = await startOAuthCallbackServer({
      appOrigin,
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

        const credential = await providerDefinition.exchangeCode({
          code: callbackPayload.code,
          state: callbackPayload.state,
          verifier: flow.verifier,
        });
        const persistedAttempt = attemptsById.get(attemptId);
        if (!persistedAttempt || persistedAttempt.attempt.status !== "pending") {
          return;
        }
        const updatedAt = Date.now();
        await persistCredential({
          credential,
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
        logger.warn(
          {
            err: error,
            providerId,
          },
          "Failed to exchange sandbox provider credential",
        );
        finalizeAttempt({
          attemptId,
          errorMessage:
            sanitizeCloudAuthErrorMessage(
              error instanceof Error ? error.message : "Cloud auth exchange failed",
            ),
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
      for (const attemptId of [...attemptsById.keys()]) {
        const attemptState = attemptsById.get(attemptId);
        if (!attemptState) {
          continue;
        }
        clearAttemptTimers(attemptState);
        await closeAttemptCallbackServer(attemptId);
        attemptsById.delete(attemptId);
      }
      pendingAttemptIdsByProvider.clear();
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
    async startConnection({ appOrigin, providerId }) {
      return startConnection(providerId, appOrigin);
    },
  };
}
