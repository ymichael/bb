import { hc, type ClientRequestOptions } from "hono/client";
import type { PublicApiRoutes } from "./public-api.js";

export type PublicApiFetch = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

export interface PublicApiClientOptions {
  fetch: PublicApiFetch;
}

function toHonoClientOptions(
  options: PublicApiClientOptions | undefined,
): ClientRequestOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return { fetch: options.fetch as typeof fetch };
}

export function createPublicApiClient(
  baseUrl: string,
  options?: PublicApiClientOptions,
) {
  return hc<PublicApiRoutes>(`${baseUrl}/api/v1`, toHonoClientOptions(options));
}

export function createApiClient(
  baseUrl: string,
  options?: PublicApiClientOptions,
) {
  const apiClient = createPublicApiClient(baseUrl, options);
  return {
    api: {
      v1: apiClient,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
