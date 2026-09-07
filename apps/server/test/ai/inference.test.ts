import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  InferenceTimeoutError,
  inferenceComplete,
} from "../../src/services/ai/inference.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const titleSchema = Type.Object({
  title: Type.String(),
});

describe("inferenceComplete", () => {
  it("surfaces missing host for a plugin-served service", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        registerFakeAiService(harness.deps.aiServices);
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).rejects.toMatchObject({
          body: {
            code: "host_unavailable",
          },
          status: 502,
        });
      },
    );
  });

  it("refuses a configured service no plugin registers", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).resolves.toBeNull();
      },
    );
  });

  it("routes a server-direct provider id past a registered service of the same id", async () => {
    await withTestHarness(
      {
        inferenceModel: "openai/no-such-model",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        const fake = registerFakeAiService(harness.deps.aiServices, {
          id: "openai",
          completeInference: () => ({
            ok: true,
            model: "x",
            value: { title: "captured" },
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).resolves.toBeNull();
        expect(fake.inferenceCalls).toHaveLength(0);
      },
    );
  });

  it("routes inference to the registered service and validates structured output", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const fake = registerFakeAiService(harness.deps.aiServices, {
          completeInference: (input) => ({
            ok: true,
            model: input.model,
            value: { title: "Generated title" },
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).resolves.toEqual({ title: "Generated title" });
        expect(fake.inferenceCalls).toHaveLength(1);
        expect(fake.inferenceCalls[0]?.input).toMatchObject({
          serviceId: "codex",
          model: "gpt-5.6-luna",
          reasoningEffort: "none",
          prompt: "Generate a title",
          timeoutMs: 5000,
        });
        expect(fake.inferenceCalls[0]?.options).toMatchObject({
          hostId: host.id,
          timeoutMs: 6000,
        });
      },
    );
  });

  it("routes an explicit fallback model instead of the configured primary", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        const fake = registerFakeAiService(harness.deps.aiServices, {
          completeInference: (input) => ({
            ok: true,
            model: input.model,
            value: { title: "Fallback title" },
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            model: "codex/gpt-5.4-mini",
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).resolves.toEqual({ title: "Fallback title" });
        expect(fake.inferenceCalls[0]?.input.model).toBe("gpt-5.4-mini");
      },
    );
  });

  it("rejects a structured result that does not satisfy the schema", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        registerFakeAiService(harness.deps.aiServices, {
          completeInference: (input) => ({
            ok: true,
            model: input.model,
            value: { headline: "not a title" },
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).rejects.toThrow();
      },
    );
  });

  it("converts a service timeout into an inference timeout", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        registerFakeAiService(harness.deps.aiServices, {
          completeInference: () => ({
            ok: false,
            code: "timeout",
            message: "Codex request timed out after 5000ms",
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).rejects.toBeInstanceOf(InferenceTimeoutError);
      },
    );
  });

  it("surfaces a service auth failure as a non-retryable error", async () => {
    await withTestHarness(
      {
        inferenceModel: "codex/gpt-5.6-luna",
      },
      async (harness) => {
        seedHostSession(harness.deps);
        registerFakeAiService(harness.deps.aiServices, {
          completeInference: () => ({
            ok: false,
            code: "auth_required",
            message: "Codex auth file not found",
          }),
        });
        await expect(
          inferenceComplete(harness.deps, {
            prompt: "Generate a title",
            schema: titleSchema,
            timeoutMs: 5000,
          }),
        ).rejects.toMatchObject({
          body: { code: "ai_service_auth_required", retryable: false },
          status: 502,
        });
      },
    );
  });
});
