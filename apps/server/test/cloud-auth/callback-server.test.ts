import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startOAuthCallbackServer } from "../../src/services/cloud-auth/callback-server.js";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve callback test port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

describe("OAuth callback server", () => {
  it("accepts the matching callback and redirects to the app", async () => {
    const port = await reservePort();
    const server = await startOAuthCallbackServer({
      appOrigin: "http://localhost:5173",
      errorTitle: "OAuth failed",
      expectedState: "expected-state",
      listenHost: "127.0.0.1",
      path: "/callback",
      port,
      successTitle: "OAuth completed",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?code=test-code&state=expected-state`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("status=success");
      expect(location).toContain("OAuth+completed");
      await expect(server.waitForCode()).resolves.toEqual({
        code: "test-code",
        state: "expected-state",
      });
    } finally {
      await server.close();
    }
  });

  it("safely encodes reflected provider errors in the redirect URL", async () => {
    const port = await reservePort();
    const server = await startOAuthCallbackServer({
      appOrigin: "http://localhost:5173",
      errorTitle: "OAuth failed",
      expectedState: "expected-state",
      listenHost: "127.0.0.1",
      path: "/callback",
      port,
      successTitle: "OAuth completed",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?error=${encodeURIComponent("<script>alert(1)</script>")}`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("status=error");
      // The error value is URL-encoded, not raw HTML
      expect(location).not.toContain("<script>");

      server.cancelWait();
      await expect(server.waitForCode()).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it("redirects with errors for wrong paths, missing params, and state mismatches", async () => {
    const port = await reservePort();
    const server = await startOAuthCallbackServer({
      appOrigin: "http://localhost:5173",
      errorTitle: "OAuth failed",
      expectedState: "expected-state",
      listenHost: "127.0.0.1",
      path: "/callback",
      port,
      successTitle: "OAuth completed",
    });

    try {
      const wrongPath = await fetch(`http://127.0.0.1:${port}/wrong-path`, {
        redirect: "manual",
      });
      expect(wrongPath.status).toBe(302);
      const wrongPathLocation = wrongPath.headers.get("location") ?? "";
      expect(wrongPathLocation).toContain("status=error");
      expect(wrongPathLocation).toContain("Callback+not+found");

      const missingParams = await fetch(`http://127.0.0.1:${port}/callback`, {
        redirect: "manual",
      });
      expect(missingParams.status).toBe(302);
      const missingLocation = missingParams.headers.get("location") ?? "";
      expect(missingLocation).toContain("status=error");

      const mismatchedState = await fetch(
        `http://127.0.0.1:${port}/callback?code=test-code&state=wrong-state`,
        { redirect: "manual" },
      );
      expect(mismatchedState.status).toBe(302);
      const mismatchLocation = mismatchedState.headers.get("location") ?? "";
      expect(mismatchLocation).toContain("status=error");

      server.cancelWait();
      await expect(server.waitForCode()).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });
});
