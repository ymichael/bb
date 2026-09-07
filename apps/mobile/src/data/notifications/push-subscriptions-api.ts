import { BbHttpError, createBrowserBbSdk } from "@bb/sdk/browser";
import { z } from "zod";
import {
  pushSubscriptionsAddOutputSchema,
  pushSubscriptionsListOutputSchema,
  pushSubscriptionsRemoveOutputSchema,
  type PushSubscriptionInput,
  type PushSubscriptionRecord,
  type PushSubscriptionRef,
} from "./push-contract";

export const PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS =
  "Push notifications plugin is disabled on this server";

const PLUGIN_ID = "push-notifications";

const rpcErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_input",
  "handler_error",
  "invalid_output",
  "non_json_result",
  "unknown_method",
]);

const rpcFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.union([
      z.string(),
      z
        .object({
          code: rpcErrorCodeSchema,
          message: z.string(),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;
type PushRpcInput =
  | PushSubscriptionInput
  | { id: string }
  | Record<string, never>;

class PushRpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "PushRpcError";
    this.code = code;
  }
}

function isDisabledPluginMessage(message: string): boolean {
  return (
    message === "unknown plugin" ||
    message.startsWith(`unknown plugin "${PLUGIN_ID}"`) ||
    message.includes(`plugin "${PLUGIN_ID}" is not running`)
  );
}

function mapRpcError(error: unknown): Error {
  if (!(error instanceof BbHttpError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const failure = rpcFailureSchema.safeParse(error.body);
  if (!failure.success) return error;
  if (typeof failure.data.error === "string") {
    if (isDisabledPluginMessage(failure.data.error)) {
      return new Error(PUSH_NOTIFICATIONS_PLUGIN_DISABLED_STATUS);
    }
    return new Error(failure.data.error);
  }
  return new PushRpcError(
    failure.data.error.code,
    failure.data.error.message,
  );
}

function isMissingSubscriptionError(error: Error): boolean {
  return (
    error instanceof PushRpcError &&
    error.code === "handler_error" &&
    error.message.startsWith("Push subscription not found:")
  );
}

export interface PushSubscriptionsApi {
  register(
    serverUrl: string,
    input: PushSubscriptionInput,
  ): Promise<{ subscriptionId: string }>;
  unregister(serverUrl: string, ref: PushSubscriptionRef): Promise<void>;
  list(serverUrl: string): Promise<PushSubscriptionRecord[]>;
}

export function createPushSubscriptionsApi(
  fetchImpl: typeof fetch,
): PushSubscriptionsApi {
  const clients = new Map<string, ReturnType<typeof createBrowserBbSdk>>();

  function sdkFor(serverUrl: string) {
    const key = serverUrl.replace(/\/+$/u, "");
    let sdk = clients.get(key);
    if (!sdk) {
      sdk = createBrowserBbSdk({ baseUrl: key, fetch: fetchImpl });
      clients.set(key, sdk);
    }
    return sdk;
  }

  async function callRpc<T>(
    serverUrl: string,
    method: string,
    input: PushRpcInput,
    outputSchema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await sdkFor(serverUrl).plugins.callRpc({
        pluginId: PLUGIN_ID,
        method,
        input,
        outputSchema,
      });
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  async function remove(serverUrl: string, id: string): Promise<void> {
    try {
      await callRpc(
        serverUrl,
        "pushSubscriptions.remove",
        { id },
        pushSubscriptionsRemoveOutputSchema,
      );
    } catch (error) {
      if (error instanceof Error && isMissingSubscriptionError(error)) return;
      throw error;
    }
  }

  async function list(serverUrl: string): Promise<PushSubscriptionRecord[]> {
    const result = await callRpc(
      serverUrl,
      "pushSubscriptions.list",
      {},
      pushSubscriptionsListOutputSchema,
    );
    return result.subscriptions;
  }

  return {
    async register(serverUrl, input) {
      const result = await callRpc(
        serverUrl,
        "pushSubscriptions.add",
        input,
        pushSubscriptionsAddOutputSchema,
      );
      return { subscriptionId: result.id };
    },
    async unregister(serverUrl, ref) {
      if (ref.subscriptionId !== null) {
        await remove(serverUrl, ref.subscriptionId);
        return;
      }
      const rows = await list(serverUrl);
      const matches = rows.filter((row) => row.tokenSuffix === ref.tokenSuffix);
      if (matches.length === 1 && matches[0]) {
        await remove(serverUrl, matches[0].id);
      }
    },
    list,
  };
}
