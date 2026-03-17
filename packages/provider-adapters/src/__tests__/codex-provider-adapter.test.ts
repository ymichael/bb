import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../codex-models.js", () => ({
  listCodexModels: vi.fn(),
}));

import { listCodexModels } from "../codex-models.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";

describe("codex provider adapter", () => {
  const mockedListCodexModels = listCodexModels as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes event type tokens", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.normalizeEventType("turn.started")).toBe("turn/started");
    expect(adapter.normalizeEventType("THREAD/NAME/UPDATED")).toBe(
      "thread/name/updated",
    );
  });

  it("opts out of duplicate legacy item lifecycle notifications", () => {
    const adapter = createCodexProviderAdapter();
    const params = adapter.createInitializeParams?.({
      name: "bb",
      version: "0.0.1",
    });

    expect(params).toMatchObject({
      clientInfo: {
        name: "bb",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: expect.arrayContaining([
          "codex/event/item_started",
          "codex/event/item_completed",
        ]),
      },
    });
  });

  it("suppresses legacy notifications and delta broadcasts", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.shouldPersistEvent?.("codex/event/item_started", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("codex/event/item_completed", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("codex/event/token_count", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("thread/name/updated", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("item/started", {})).toBe(true);
    expect(adapter.shouldBroadcastForEvent("item/agentMessage/delta")).toBe(false);
    expect(adapter.shouldBroadcastForEvent("item/completed")).toBe(true);
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createCodexProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: true,
      supportsServiceTier: true,
    });
  });

  it("lists models through the injected implementation", async () => {
    mockedListCodexModels.mockResolvedValue([
      {
        id: "codex-mini",
        model: "codex-mini",
        displayName: "Codex Mini",
        description: "Fast coding model",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ]);

    const adapter = createCodexProviderAdapter();
    await expect(adapter.listModels()).resolves.toHaveLength(1);
  });
});
