import { describe, expect, it } from "vitest";
import {
  bbAppManagedConfigSchema,
  formatCustomAcpAgentProviderId,
  parseBbAppManagedConfig,
} from "../src/bb-app-managed-config.js";

describe("bbAppManagedConfigSchema", () => {
  it("parses shared user and project skill roots", () => {
    expect(
      parseBbAppManagedConfig({
        sharedSkillRoots: {
          user: [".agents/skills"],
          project: [".agents/skills"],
        },
      }).sharedSkillRoots,
    ).toEqual({
      user: [".agents/skills"],
      project: [".agents/skills"],
    });
  });

  it("parses custom models with a known provider", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customModels: [
        {
          providerId: "claude-code",
          model: "claude-example-preview[1m]",
          displayName: "Example Preview (1M)",
        },
        { providerId: "pi", model: "anthropic/claude-example-preview" },
      ],
    });

    expect(parsed.customModels).toHaveLength(2);
    expect(parsed.customModels?.[0]?.providerId).toBe("claude-code");
    expect(parsed.customModels?.[1]?.displayName).toBeUndefined();
  });

  it("parses custom models with dynamic ACP provider ids", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customModels: [
        {
          providerId: "acp-opencode",
          model: "my-proxy/custom-model",
          displayName: "My Proxy Custom Model",
        },
        { providerId: "acp-my-agent", model: "provider/model" },
      ],
    });

    expect(parsed.customModels).toHaveLength(2);
    expect(parsed.customModels?.[0]?.providerId).toBe("acp-opencode");
    expect(parsed.customModels?.[1]?.providerId).toBe("acp-my-agent");
  });

  it("rejects malformed acp-* custom model provider ids", () => {
    for (const providerId of ["acp-", "acp-Bad-Agent", "acp--x"]) {
      expect(
        bbAppManagedConfigSchema.safeParse({
          customModels: [{ providerId, model: "provider/model" }],
        }).success,
      ).toBe(false);
    }
  });

  it("drops invalid custom model entries with warnings at the config boundary", () => {
    const warnings: Record<string, unknown>[] = [];
    const parsed = parseBbAppManagedConfig(
      {
        customModels: [
          { providerId: "acp-opencode", model: "my-proxy/custom-model" },
          { providerId: "not-a-provider", model: "other-model" },
          { providerId: "claude-code", model: "" },
        ],
      },
      {
        logger: {
          warn(fields): void {
            warnings.push(fields);
          },
        },
      },
    );

    expect(parsed.customModels).toEqual([
      { providerId: "acp-opencode", model: "my-proxy/custom-model" },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.index)).toEqual([1, 2]);
  });

  it("rejects custom models with an unknown provider", () => {
    const result = bbAppManagedConfigSchema.safeParse({
      customModels: [
        { providerId: "not-a-provider", model: "claude-example-preview" },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "customModels",
        0,
        "providerId",
      ]);
    }
  });

  it("rejects custom models with an empty model id", () => {
    const result = bbAppManagedConfigSchema.safeParse({
      customModels: [{ providerId: "claude-code", model: "" }],
    });

    expect(result.success).toBe(false);
  });

  it("parses custom ACP agents, applies local defaults, and drops empty modelCli", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          modelCli: {},
        },
      ],
    });

    expect(parsed.customAcpAgents).toEqual([
      {
        id: "my-agent",
        displayName: "My Agent",
        command: "my-agent",
        args: [],
        env: {},
        supportsManualCompaction: false,
      },
    ]);
    expect(formatCustomAcpAgentProviderId("my-agent")).toBe("acp-my-agent");
  });

  it("keeps non-empty custom ACP modelCli config", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          modelCli: {
            listArgs: ["models"],
            selectFlag: "--model",
            primaryModels: ["model-a"],
          },
        },
      ],
    });

    expect(parsed.customAcpAgents?.[0]).toEqual({
      id: "my-agent",
      displayName: "My Agent",
      command: "my-agent",
      args: [],
      env: {},
      supportsManualCompaction: false,
      modelCli: {
        listArgs: ["models"],
        selectFlag: "--model",
        primaryModels: ["model-a"],
      },
    });
  });

  it("keeps a supported custom ACP logo path", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          logo: "agent-logos/my-agent.svg",
        },
      ],
    });

    expect(parsed.customAcpAgents?.[0]?.logo).toBe("agent-logos/my-agent.svg");
  });

  it("rejects an unsupported custom ACP logo format", () => {
    const parsed = bbAppManagedConfigSchema.safeParse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          logo: "agent-logos/my-agent.gif",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps custom ACP reasoningCli config", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          reasoningCli: {
            flag: "--reasoning-effort",
            supportedLevels: ["low", "medium", "high"],
            levelValues: { max: "high" },
            defaultLevel: "high",
          },
        },
      ],
    });

    expect(parsed.customAcpAgents?.[0]).toEqual({
      id: "my-agent",
      displayName: "My Agent",
      command: "my-agent",
      args: [],
      env: {},
      supportsManualCompaction: false,
      reasoningCli: {
        flag: "--reasoning-effort",
        supportedLevels: ["low", "medium", "high"],
        levelValues: { max: "high" },
        defaultLevel: "high",
      },
    });
  });

  it("keeps custom ACP nativeReasoning config", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "my-agent",
          displayName: "My Agent",
          command: "my-agent",
          nativeReasoning: {
            configId: "reasoning_effort",
            supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
            defaultLevel: "medium",
          },
        },
      ],
    });

    expect(parsed.customAcpAgents?.[0]).toEqual({
      id: "my-agent",
      displayName: "My Agent",
      command: "my-agent",
      args: [],
      env: {},
      supportsManualCompaction: false,
      nativeReasoning: {
        configId: "reasoning_effort",
        supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "medium",
      },
    });
  });

  it("keeps portable custom ACP native skill roots", () => {
    const parsed = bbAppManagedConfigSchema.parse({
      customAcpAgents: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp-acp",
          nativeSkillRoots: {
            user: [".agents/skills"],
            project: [".agents/skills", ".amp/skills"],
          },
        },
      ],
    });

    expect(parsed.customAcpAgents?.[0]?.nativeSkillRoots).toEqual({
      user: [".agents/skills"],
      project: [".agents/skills", ".amp/skills"],
    });
  });

  it("rejects unsafe custom ACP native skill roots", () => {
    for (const root of ["/tmp/skills", "../skills", "skills/../other"]) {
      expect(
        bbAppManagedConfigSchema.safeParse({
          customAcpAgents: [
            {
              id: "amp",
              displayName: "Amp",
              command: "amp-acp",
              nativeSkillRoots: { user: [root] },
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("refuses the removed `absolute` side by name on sharedSkillRoots and on a custom ACP agent", () => {
    const shared = bbAppManagedConfigSchema.safeParse({
      sharedSkillRoots: { user: [".agents/skills"], project: [], absolute: [] },
    });
    expect(shared.success).toBe(false);
    if (!shared.success) {
      expect(
        shared.error.issues.map((issue) => [issue.path, issue.message]),
      ).toEqual([[["sharedSkillRoots"], 'Unrecognized key: "absolute"']]);
    }
    expect(() =>
      parseBbAppManagedConfig({
        sharedSkillRoots: { user: [], project: [], absolute: ["/srv/skills"] },
      }),
    ).toThrow(/Unrecognized key/u);

    const warnings: Record<string, unknown>[] = [];
    const parsed = parseBbAppManagedConfig(
      {
        customAcpAgents: [
          {
            id: "amp",
            displayName: "Amp",
            command: "amp-acp",
            nativeSkillRoots: {
              user: [".amp/skills"],
              absolute: ["/srv/skills"],
            },
          },
        ],
      },
      {
        logger: {
          warn(fields): void {
            warnings.push(fields);
          },
        },
      },
    );
    expect(parsed.customAcpAgents).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.index).toBe(0);
    expect(warnings[0]?.error).toMatch(/Unrecognized key: \\"absolute\\"/u);
  });

  it("rejects custom ACP reasoningCli defaults outside supported levels", () => {
    expect(
      bbAppManagedConfigSchema.safeParse({
        customAcpAgents: [
          {
            id: "my-agent",
            displayName: "My Agent",
            command: "my-agent",
            reasoningCli: {
              flag: "--reasoning-effort",
              supportedLevels: ["low", "medium"],
              defaultLevel: "high",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects custom ACP agents with invalid ids, missing commands, collisions, and duplicates", () => {
    expect(
      bbAppManagedConfigSchema.safeParse({
        customAcpAgents: [
          { id: "Bad-Agent", displayName: "Bad", command: "bad" },
        ],
      }).success,
    ).toBe(false);
    expect(
      bbAppManagedConfigSchema.safeParse({
        customAcpAgents: [{ id: "missing-command", displayName: "Missing" }],
      }).success,
    ).toBe(false);
    expect(
      bbAppManagedConfigSchema.safeParse({
        customAcpAgents: [
          { id: "cursor", displayName: "Cursor Collision", command: "agent" },
        ],
      }).success,
    ).toBe(false);
    expect(
      bbAppManagedConfigSchema.safeParse({
        customAcpAgents: [
          { id: "one", displayName: "One", command: "one" },
          { id: "one", displayName: "Duplicate", command: "duplicate" },
        ],
      }).success,
    ).toBe(false);
  });

  it("drops invalid custom ACP agent entries with warnings at the config boundary", () => {
    const warnings: Record<string, unknown>[] = [];
    const parsed = parseBbAppManagedConfig(
      {
        customAcpAgents: [
          { id: "good", displayName: "Good", command: "good" },
          { id: "bad id", displayName: "Bad", command: "bad" },
          { id: "good", displayName: "Duplicate", command: "duplicate" },
          { id: "cursor", displayName: "Cursor Collision", command: "agent" },
        ],
      },
      {
        logger: {
          warn(fields): void {
            warnings.push(fields);
          },
        },
      },
    );

    expect(parsed.customAcpAgents).toEqual([
      {
        id: "good",
        displayName: "Good",
        command: "good",
        args: [],
        env: {},
        supportsManualCompaction: false,
      },
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings.map((warning) => warning.index)).toEqual([1, 2, 3]);
  });
});
