import { describe, expect, it } from "vitest";
import { hosts } from "@bb/db";
import { initDb } from "../src/db.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("server skeleton", () => {
  it("serves public routes without auth", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/api/v1/hosts");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects internal routes without a bearer token", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hostType: "persistent",
          protocolVersion: 2,
        }),
      });

      expect(response.status).toBe(401);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "unauthorized",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns structured invalid_request errors for malformed JSON", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("initializes an in-memory database and applies migrations", () => {
    const db = initDb(":memory:");
    expect(db.select().from(hosts).all()).toEqual([]);
  });
});
