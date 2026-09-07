import { MOBILE_APP_SURFACE_HEADER } from "./app-surface";

export interface MobileFetchOptions {
  onAuthFailure?: (status: number) => void;
}

export function createMobileFetch(
  baseFetch: typeof fetch,
  options: MobileFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(
      MOBILE_APP_SURFACE_HEADER.name,
      MOBILE_APP_SURFACE_HEADER.value,
    );
    const response = await baseFetch(input, { ...init, headers });
    if (response.status === 401 || response.status === 403) {
      options.onAuthFailure?.(response.status);
    }
    return response;
  };
}
