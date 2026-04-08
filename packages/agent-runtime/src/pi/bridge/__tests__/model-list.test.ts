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
    supportsXhigh.mockImplementation((model: { provider: string }) => model.provider === "anthropic");

    await expect(listPiBridgeModels()).resolves.toEqual([
      {
        id: "anthropic/claude-sonnet-4",
        model: "anthropic/claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        description: "Anthropic reasoning, multimodal model via Pi",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low reasoning effort" },
          { reasoningEffort: "medium", description: "Medium reasoning effort" },
          { reasoningEffort: "high", description: "High reasoning effort" },
          { reasoningEffort: "xhigh", description: "Extra high reasoning effort" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ]);
  });
});
