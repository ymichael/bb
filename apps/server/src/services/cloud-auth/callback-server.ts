import { createServer, type Server } from "node:http";

export interface OAuthCallbackPayload {
  code: string;
  state: string;
}

export interface StartOAuthCallbackServerArgs {
  appOrigin: string;
  errorTitle: string;
  expectedState: string;
  listenHost: string;
  path: string;
  port: number;
  successTitle: string;
}

export interface OAuthCallbackServer {
  cancelWait(): void;
  close(): Promise<void>;
  waitForCode(): Promise<OAuthCallbackPayload | null>;
}

function buildCallbackRedirectUrl(
  appOrigin: string,
  args: { message: string; status: "success" | "error"; title: string },
): string {
  // In production the app is served from the same origin as the server,
  // but the callback server runs on a different port. Use an absolute URL
  // so the browser navigates to the app's origin.
  const url = new URL("/auth/callback", appOrigin);
  url.searchParams.set("status", args.status);
  url.searchParams.set("title", args.title);
  url.searchParams.set("message", args.message);
  return url.toString();
}

function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startOAuthCallbackServer(
  args: StartOAuthCallbackServerArgs,
): Promise<OAuthCallbackServer> {
  let settleWait: ((value: OAuthCallbackPayload | null) => void) | null = null;
  let settled = false;
  const waitForCode = new Promise<OAuthCallbackPayload | null>((resolve) => {
    settleWait = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
  });

  function redirect(response: import("node:http").ServerResponse, location: string): void {
    response.writeHead(302, { location });
    response.end();
  }

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      if (requestUrl.pathname !== args.path) {
        redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
          message: "This OAuth callback route does not exist for the active connection attempt.",
          status: "error",
          title: "Callback not found",
        }));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
          message: `The provider returned an OAuth error: ${error}.`,
          status: "error",
          title: args.errorTitle,
        }));
        return;
      }

      if (!code || !state) {
        redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
          message: "The callback is missing the expected authorization code or state.",
          status: "error",
          title: args.errorTitle,
        }));
        return;
      }

      if (state !== args.expectedState) {
        redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
          message: "The returned OAuth state does not match the active connection attempt.",
          status: "error",
          title: args.errorTitle,
        }));
        return;
      }

      redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
        message: "Authentication completed. You can close this window.",
        status: "success",
        title: args.successTitle,
      }));
      settleWait?.({ code, state });
    } catch {
      redirect(response, buildCallbackRedirectUrl(args.appOrigin, {
        message: "An internal error occurred while processing the OAuth callback.",
        status: "error",
        title: args.errorTitle,
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    cancelWait() {
      settleWait?.(null);
    },
    async close() {
      settleWait?.(null);
      await closeServer(server).catch(() => undefined);
    },
    waitForCode() {
      return waitForCode;
    },
  };
}
