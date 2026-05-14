import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownProvider } from "@mariozechner/pi-ai";

const getProviders = vi.fn<() => KnownProvider[]>();
const getModels = vi.fn();
const supportsXhigh = vi.fn();
const hasAuth = vi.fn();
const createAuthStorage = vi.fn(() => ({ hasAuth }));

vi.mock("@mariozechner/pi-ai", () => ({
  getProviders,
  getModels,
  supportsXhigh,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: createAuthStorage,
  },
}));

import { listPiBridgeModels } from "../model-list.js";

describe("pi bridge model list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds available models from the Pi SDK and auth storage", async () => {
    getProviders.mockReturnValue(["anthropic", "openai"]);
    hasAuth.mockImplementation((provider: string) => provider !== "openai");
    getModels.mockImplementation((provider: string) => {
      if (provider === "anthropic") {
        return [
          {
            id: "claude-sonnet-4",
            input: ["text", "image"],
            name: "Claude Sonnet 4",
            provider: "anthropic",
            reasoning: true,
          },
        ];
      }
      return [
        {
          id: "codex-mini",
          input: ["text"],
          name: "Codex Mini",
          provider: "openai",
          reasoning: true,
        },
      ];
    });
    supportsXhigh.mockImplementation(
      (model: { provider: string }) => model.provider === "anthropic",
    );

    await expect(listPiBridgeModels()).resolves.toEqual({
      models: [
        {
          id: "anthropic/claude-sonnet-4",
          model: "anthropic/claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          description: "Anthropic reasoning, multimodal model via Pi",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning effort" },
            {
              reasoningEffort: "medium",
              description: "Medium reasoning effort",
            },
            { reasoningEffort: "high", description: "High reasoning effort" },
            {
              reasoningEffort: "xhigh",
              description: "Extra high reasoning effort",
            },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [],
    });
  });

  it("marks the pi-mono default openai-codex model as default when available", async () => {
    getProviders.mockReturnValue(["openai-codex"]);
    hasAuth.mockReturnValue(true);
    getModels.mockReturnValue([
      {
        id: "gpt-5.5",
        input: ["text", "image"],
        name: "GPT-5.5",
        provider: "openai-codex",
        reasoning: true,
      },
      {
        id: "gpt-5.1",
        input: ["text"],
        name: "GPT-5.1",
        provider: "openai-codex",
        reasoning: true,
      },
    ]);
    supportsXhigh.mockReturnValue(false);

    await expect(listPiBridgeModels()).resolves.toEqual({
      models: [
        {
          id: "openai-codex/gpt-5.5",
          model: "openai-codex/gpt-5.5",
          displayName: "GPT-5.5",
          description: "Openai-codex reasoning, multimodal model via Pi",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning effort" },
            {
              reasoningEffort: "medium",
              description: "Medium reasoning effort",
            },
            { reasoningEffort: "high", description: "High reasoning effort" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "openai-codex/gpt-5.1",
          model: "openai-codex/gpt-5.1",
          displayName: "GPT-5.1",
          description: "Openai-codex reasoning model via Pi",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning effort" },
            {
              reasoningEffort: "medium",
              description: "Medium reasoning effort",
            },
            { reasoningEffort: "high", description: "High reasoning effort" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ],
      selectedOnlyModels: [],
    });
  });
});
