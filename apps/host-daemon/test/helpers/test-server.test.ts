import { afterEach, describe, expect, it } from "vitest";
import { createTestServer, type TestServer } from "./test-server.js";

describe("createTestServer", () => {
  let testServer: TestServer | null = null;

  afterEach(async () => {
    await testServer?.close();
    testServer = null;
  });

  it("rejects inactive session requests when active session enforcement is enabled", async () => {
    testServer = await createTestServer({ enforceActiveSessions: true });

    const response = await fetch(
      `${testServer.baseUrl}/internal/session/events`,
      {
        body: JSON.stringify({
          sessionId: "session-stale",
          events: [],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_session",
      message: "Session is not open",
      retryable: false,
    });
    expect(testServer.rejectedSessionRequests).toEqual([
      {
        path: "/internal/session/events",
        sessionId: "session-stale",
      },
    ]);
  });
});
