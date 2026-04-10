import { createServer, type Server } from "node:http";

export interface OAuthCallbackPayload {
  code: string;
  state: string;
}

export interface StartOAuthCallbackServerArgs {
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(args: { body: string; title: string }): string {
  const body = escapeHtml(args.body);
  const title = escapeHtml(args.title);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    `  <title>${title}</title>`,
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <style>",
    "    body { font-family: sans-serif; background: #f5f3eb; color: #1f2937; margin: 0; }",
    "    main { max-width: 32rem; margin: 4rem auto; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08); }",
    "    h1 { margin-top: 0; font-size: 1.25rem; }",
    "    p { line-height: 1.5; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    `    <h1>${title}</h1>`,
    `    <p>${body}</p>`,
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
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

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      if (requestUrl.pathname !== args.path) {
        response.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          renderHtml({
            body: "This OAuth callback route does not exist for the active connection attempt.",
            title: "Callback not found",
          }),
        );
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        response.writeHead(400, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          renderHtml({
            body: `The provider returned an OAuth error: ${error}.`,
            title: args.errorTitle,
          }),
        );
        return;
      }

      if (!code || !state) {
        response.writeHead(400, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          renderHtml({
            body: "The callback is missing the expected authorization code or state.",
            title: args.errorTitle,
          }),
        );
        return;
      }

      if (state !== args.expectedState) {
        response.writeHead(400, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          renderHtml({
            body: "The returned OAuth state does not match the active connection attempt.",
            title: args.errorTitle,
          }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        renderHtml({
          body: "Authentication completed. You can close this window and return to bb.",
          title: args.successTitle,
        }),
      );
      settleWait?.({ code, state });
    } catch {
      response.writeHead(500, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        renderHtml({
          body: "bb hit an internal error while processing the OAuth callback.",
          title: args.errorTitle,
        }),
      );
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
