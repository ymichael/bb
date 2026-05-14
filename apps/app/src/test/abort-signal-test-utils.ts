import { installFetchRoutes, jsonResponse } from "./http-test-utils";

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AbortableJsonRouteArgs {
  body: JsonValue;
  pathname: string;
}

interface AbortableJsonRouteHarness {
  getSignal: () => AbortSignal | null;
}

export function installAbortableJsonRoute({
  body,
  pathname,
}: AbortableJsonRouteArgs): AbortableJsonRouteHarness {
  let signal: AbortSignal | null = null;

  installFetchRoutes([
    {
      pathname,
      handler: (request) => {
        signal = request.signal;
        return new Promise<Response>((resolve) => {
          if (request.signal.aborted) {
            resolve(jsonResponse(body));
            return;
          }
          request.signal.addEventListener(
            "abort",
            () => {
              resolve(jsonResponse(body));
            },
            { once: true },
          );
        });
      },
    },
  ]);

  return {
    getSignal: () => signal,
  };
}
