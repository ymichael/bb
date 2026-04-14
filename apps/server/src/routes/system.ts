import { cloudAuthProviderIdSchema } from "@bb/agent-providers";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  cloudAuthConnectRequestSchema,
  githubReposQuerySchema,
  sandboxEnvVarNameSchema,
  upsertSandboxEnvVarRequestSchema,
  systemModelsQuerySchema,
  systemProvidersQuerySchema,
  typedRoutes,
  type PublicApiSchema,
  type SystemProvidersQuery,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  requireEnvironment,
  requireDefaultConnectedPersistentHostId,
  requireNonDestroyedHostWithStatus,
} from "../services/lib/entity-lookup.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { listAvailableSandboxBackends } from "../services/hosts/sandbox-backends.js";
import { isSandboxProvisioningConfigured } from "../services/hosts/sandbox-config.js";
import { transcribeVoiceInput } from "../services/ai/voice-transcription.js";
import { fetchGithubRepos } from "../services/github/repos.js";

type HostLookupQuery = Pick<SystemProvidersQuery, "environmentId" | "hostId">;

function resolveSystemLookupHostId(deps: AppDeps, query: HostLookupQuery): string {
  if (query.environmentId) {
    return requireEnvironment(deps.db, query.environmentId).hostId;
  }
  if (query.hostId) {
    requireNonDestroyedHostWithStatus(deps.db, query.hostId);
    return query.hostId;
  }
  return requireDefaultConnectedPersistentHostId(deps.db);
}

export function registerSystemRoutes(app: Hono, deps: AppDeps): void {
  const { del, get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/system/config", (context) =>
    context.json({
      githubConnected: deps.config.githubPat !== "",
      hostDaemonPort: deps.config.hostDaemonPort,
      sandboxHostSupported: isSandboxProvisioningConfigured(deps.config),
      voiceTranscriptionEnabled: !!deps.config.openAiApiKey,
    }),
  );

  get("/system/cloud-auth", async (context) =>
    context.json({
      connections: await deps.cloudAuth.listConnections(),
    }),
  );

  post("/system/cloud-auth/:providerId/connect", cloudAuthConnectRequestSchema, async (context, { appOrigin }) => {
    const providerId = cloudAuthProviderIdSchema.parse(
      context.req.param("providerId"),
    );
    const parsed = new URL(appOrigin);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      const allowedOrigins = new Set<string>();
      if (deps.config.appUrl) {
        allowedOrigins.add(new URL(deps.config.appUrl).origin);
      }
      if (!allowedOrigins.has(parsed.origin)) {
        throw new ApiError(400, "invalid_app_origin", "The provided app origin is not allowed.");
      }
    }
    return context.json(
      await deps.cloudAuth.startConnection({ appOrigin, providerId }),
      201,
    );
  });

  get("/system/cloud-auth/attempts/:attemptId", (context) => {
    const attemptId = context.req.param("attemptId");
    const attempt = deps.cloudAuth.getAttempt({ attemptId });
    if (!attempt) {
      throw new ApiError(404, "cloud_auth_attempt_not_found", "Cloud auth attempt not found");
    }
    return context.json(attempt);
  });

  del("/system/cloud-auth/:providerId", async (context) => {
    const providerId = cloudAuthProviderIdSchema.parse(
      context.req.param("providerId"),
    );
    await deps.cloudAuth.disconnectProvider({ providerId });
    return context.json({ ok: true });
  });

  get("/system/sandbox-env-vars", async (context) =>
    context.json({
      envVars: await deps.sandboxEnv.listEnvVars(),
    }),
  );

  post("/system/sandbox-env-vars", upsertSandboxEnvVarRequestSchema, async (context, payload) =>
    context.json(await deps.sandboxEnv.upsertEnvVar(payload)),
  );

  del("/system/sandbox-env-vars/:name", async (context) => {
    const name = sandboxEnvVarNameSchema.parse(context.req.param("name"));
    await deps.sandboxEnv.deleteEnvVar({ name });
    return context.json({ ok: true });
  });

  get("/system/sandbox-backends", (context) =>
    context.json(listAvailableSandboxBackends(deps.config)),
  );

  get("/system/github-repos", githubReposQuerySchema, async (context, query) => {
    if (!deps.config.githubPat) {
      throw new ApiError(501, "not_configured", "GitHub PAT is not configured");
    }
    return context.json(await fetchGithubRepos(deps.config.githubPat, query.q));
  });

  get("/system/providers", systemProvidersQuerySchema, async (context, query) => {
    const hostId = resolveSystemLookupHostId(deps, query);
    const rawResult = await queueCommandAndWait(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: { type: "provider.list" },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["provider.list"].parse(rawResult).providers,
    );
  });

  get("/system/models", systemModelsQuerySchema, async (context, query) => {
    const hostId = resolveSystemLookupHostId(deps, query);
    if (query.providerId) {
      const rawResult = await queueCommandAndWait(deps, {
        hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "provider.list_models",
          providerId: query.providerId,
        },
      });
      return context.json(
        hostDaemonCommandResultSchemaByType["provider.list_models"].parse(rawResult).models,
      );
    }

    const providers = hostDaemonCommandResultSchemaByType["provider.list"].parse(
      await queueCommandAndWait(deps, {
        hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: { type: "provider.list" },
      }),
    ).providers;
    const models = await Promise.all(
      providers.map(async (provider) =>
        hostDaemonCommandResultSchemaByType["provider.list_models"].parse(
          await queueCommandAndWait(deps, {
            hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "provider.list_models",
              providerId: provider.id,
            },
          }),
        ).models,
      ),
    );
    return context.json(models.flat());
  });

  post("/system/voice-transcription", async (context) => {
    if (!deps.config.openAiApiKey) {
      throw new ApiError(501, "not_configured", "Voice transcription requires OPENAI_API_KEY to be configured");
    }
    const formData = await context.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "Audio file is required");
    }
    return context.json({
      text: await transcribeVoiceInput({
        file,
        openAiApiKey: deps.config.openAiApiKey,
        prompt:
          typeof formData.get("prompt") === "string"
            ? String(formData.get("prompt"))
            : undefined,
      }),
    });
  });
}
