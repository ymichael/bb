import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPiAvailableModels,
  createPiProviderAdapter,
} from "../pi-provider-adapter.js";

const ORIGINAL_HOME = process.env.HOME;

describe("pi provider adapter", () => {
  let tempHomePath = "";

  beforeEach(async () => {
    tempHomePath = await mkdtemp(join(tmpdir(), "bb-pi-auth-"));
    process.env.HOME = tempHomePath;
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;

    if (tempHomePath) {
      await rm(tempHomePath, { recursive: true, force: true });
      tempHomePath = "";
    }
  });

  it("has correct identity", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.id).toBe("pi");
    expect(adapter.displayName).toBe("Pi");
  });

  it("normalizes event type tokens", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.normalizeEventType("turn.started")).toBe("turn/started");
    expect(adapter.normalizeEventType("TURN/COMPLETED")).toBe("turn/completed");
  });

  it("derives status transitions from turn lifecycle events", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.statusForEvent("turn/started", {})).toBe("active");
    expect(adapter.statusForEvent("turn/completed", {})).toBe("idle");
    expect(adapter.statusForEvent("item/completed", {})).toBeUndefined();
    expect(adapter.statusForEvent("error", {})).toBe("error");
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
  });

  it("builds a dynamic model list from the Pi catalog", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic", "openai", "google"],
      getModels: (provider) => {
        switch (provider) {
          case "anthropic":
            return [
              {
                id: "claude-sonnet-4-20250514",
                name: "Claude Sonnet 4",
                provider: "anthropic",
                reasoning: true,
                input: ["text", "image"],
              },
            ];
          case "openai":
            return [
              {
                id: "codex-mini",
                name: "Codex Mini",
                provider: "openai",
                reasoning: true,
                input: ["text"],
              },
            ];
          default:
            return [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                provider: "google",
                reasoning: true,
                input: ["text"],
              },
            ];
        }
      },
      hasAuth: (provider) => provider !== "google",
    });

    const ids = models.map((model) => model.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).toContain("openai/codex-mini");
    expect(ids).not.toContain("google/gemini-2.5-pro");
    expect(models.find((model) => model.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("materializes host pi auth and settings into the provider child", async () => {
    const agentDir = join(tempHomePath, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "token" } }, null, 2),
      "utf8",
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic" }, null, 2),
      "utf8",
    );

    const adapter = createPiProviderAdapter();

    await expect(
      adapter.resolveLaunchConfiguration?.({
        projectId: "proj-1",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      files: [
        {
          placement: "home",
          path: ".pi/agent/auth.json",
          content: JSON.stringify(
            { anthropic: { type: "oauth", access: "token" } },
            null,
            2,
          ),
        },
        {
          placement: "home",
          path: ".pi/agent/settings.json",
          content: JSON.stringify({ defaultProvider: "anthropic" }, null, 2),
        },
      ],
    });
  });
});
