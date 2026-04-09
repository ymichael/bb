import { describe, expect, it } from "vitest";
import {
  sandboxEnvVarSchema,
  sandboxEnvVarsResponseSchema,
} from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("public sandbox env var routes", () => {
  it("lists env vars without exposing plaintext values", async () => {
    const harness = await createTestAppHarness();

    try {
      await harness.deps.sandboxEnv.upsertEnvVar({
        name: "OPENAI_API_KEY",
        value: "secret-openai-key",
      });

      const response = await harness.app.request("/api/v1/system/sandbox-env-vars");

      expect(response.status).toBe(200);
      const body = sandboxEnvVarsResponseSchema.parse(await readJson(response));
      expect(body).toEqual({
        envVars: [
          {
            createdAt: expect.any(Number),
            name: "OPENAI_API_KEY",
            updatedAt: expect.any(Number),
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("secret-openai-key");
    } finally {
      await harness.cleanup();
    }
  });

  it("creates, updates, and deletes env vars", async () => {
    const harness = await createTestAppHarness();

    try {
      const createResponse = await harness.app.request(
        "/api/v1/system/sandbox-env-vars",
        {
          method: "POST",
          body: JSON.stringify({
            name: "ANTHROPIC_API_KEY",
            value: "anthropic-secret-1",
          }),
          headers: {
            "content-type": "application/json",
          },
        },
      );

      expect(createResponse.status).toBe(200);
      const created = sandboxEnvVarSchema.parse(await readJson(createResponse));
      expect(created).toMatchObject({
        name: "ANTHROPIC_API_KEY",
      });
      expect((await harness.deps.sandboxEnv.resolveRuntimeEnv()).ANTHROPIC_API_KEY).toBe(
        "anthropic-secret-1",
      );

      const updateResponse = await harness.app.request(
        "/api/v1/system/sandbox-env-vars",
        {
          method: "POST",
          body: JSON.stringify({
            name: "ANTHROPIC_API_KEY",
            value: "anthropic-secret-2",
          }),
          headers: {
            "content-type": "application/json",
          },
        },
      );

      expect(updateResponse.status).toBe(200);
      const updated = sandboxEnvVarSchema.parse(await readJson(updateResponse));
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect((await harness.deps.sandboxEnv.resolveRuntimeEnv()).ANTHROPIC_API_KEY).toBe(
        "anthropic-secret-2",
      );

      const deleteResponse = await harness.app.request(
        "/api/v1/system/sandbox-env-vars/ANTHROPIC_API_KEY",
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });
      expect(await harness.deps.sandboxEnv.resolveRuntimeEnv()).toEqual({});
    } finally {
      await harness.cleanup();
    }
  });
});
