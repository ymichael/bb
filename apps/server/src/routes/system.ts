import {
  systemExecutionOptionsQuerySchema,
  systemProvidersQuerySchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { ServerAppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { transcribeVoiceInput } from "../services/ai/voice-transcription.js";
import {
  applyProviderFeatureFlags,
  resolveSystemExecutionOptions,
} from "../services/system/execution-options.js";
import { resolveSystemLookupHostId } from "../services/system/host-lookup.js";

export function registerSystemRoutes(app: Hono, deps: ServerAppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/system/config", (context) =>
    context.json({
      featureFlags: deps.config.featureFlags,
      hostDaemonPort: deps.config.hostDaemonPort,
      voiceTranscriptionEnabled: !!deps.config.openAiApiKey,
    }),
  );

  post("/system/config/reload", async (context) => {
    try {
      await deps.bbAppManagedConfig.reload({ notify: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(422, "invalid_config", message);
    }
    return context.json({ ok: true });
  });

  get(
    "/system/providers",
    systemProvidersQuerySchema,
    async (context, query) => {
      const hostId = resolveSystemLookupHostId(deps, query);
      const result = await queueCommandAndWait(deps, {
        hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: { type: "provider.list" },
      });
      return context.json(
        applyProviderFeatureFlags({
          featureFlags: deps.config.featureFlags,
          providers: result.providers,
        }),
      );
    },
  );

  get(
    "/system/execution-options",
    systemExecutionOptionsQuerySchema,
    async (context, query) =>
      context.json(await resolveSystemExecutionOptions(deps, query)),
  );

  post("/system/voice-transcription", async (context) => {
    if (!deps.config.openAiApiKey) {
      throw new ApiError(
        501,
        "not_configured",
        "Voice transcription requires OPENAI_API_KEY to be configured",
      );
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
