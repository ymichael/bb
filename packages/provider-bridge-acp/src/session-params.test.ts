import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAgentModelCatalog,
  parseAgentModelLines,
} from "./bridge/model-catalog.js";
import { SAMPLE_LIST } from "./bridge/model-catalog.fixture.js";
import { acpLaunchSpecSchema, type AcpLaunchSpec } from "./launch-spec.js";
import {
  buildAcpModelListParams,
  buildAcpSessionParams,
  type AcpSessionExecutionOptions,
  type AcpSessionParams,
} from "./session-params.js";

const BASE_OPTIONS = {
  permissionMode: "full",
} as const;

function launchSpecFor(spec: AcpLaunchSpec): AcpLaunchSpec {
  return acpLaunchSpecSchema.parse(spec);
}

describe("buildAcpModelListParams", () => {
  it("keeps a custom CLI catalog when model-picker options are absent", () => {
    const params = buildAcpModelListParams(
      launchSpecFor({
        displayName: "Custom ACP",
        command: "custom-agent",
        args: ["serve"],
        env: { CUSTOM_AGENT_TOKEN: "token" },
        cwd: "/agent-home",
        modelCli: {
          listArgs: ["models", "list"],
          selectFlag: "--model",
          primaryModels: ["model-a"],
        },
      }),
      {
        parameterizedModelPicker: false,
        reasoningProbePriorityModelIds: [],
      },
    );

    expect(params).toEqual({
      listCommand: {
        command: "custom-agent",
        args: ["models", "list"],
        cwd: "/agent-home",
        envVars: { CUSTOM_AGENT_TOKEN: "token" },
      },
      primaryModels: ["model-a"],
      reasoningProbePriorityModelIds: [],
      parameterizedModelPicker: false,
    });
  });

  it("passes launch-time reasoning CLI config through to discovery", () => {
    const reasoningCli: NonNullable<AcpLaunchSpec["reasoningCli"]> = {
      flag: "--reasoning-effort",
      supportedLevels: ["low", "medium", "high"],
      levelValues: { max: "high" },
      defaultLevel: "high",
    };

    expect(
      buildAcpModelListParams(
        launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: {},
          reasoningCli,
        }),
        {
          parameterizedModelPicker: false,
          reasoningProbePriorityModelIds: [],
        },
      ),
    ).toEqual({
      agent: { command: "custom-agent", args: ["serve"] },
      primaryModels: [],
      reasoningProbePriorityModelIds: [],
      parameterizedModelPicker: false,
      reasoningCli,
    });
  });

  it.each<[string, AcpLaunchSpec["modelCli"]]>([
    ["no model cli", undefined],
    [
      "empty model cli",
      { listArgs: [], selectFlag: "--model", primaryModels: ["model-a"] },
    ],
  ])(
    "falls back to ACP-native discovery over the agent command with %s",
    (_name, modelCli) => {
      const params = buildAcpModelListParams(
        launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: {},
          ...(modelCli !== undefined ? { modelCli } : {}),
        }),
        {
          parameterizedModelPicker: false,
          reasoningProbePriorityModelIds: [],
        },
      );

      expect(params).toEqual({
        agent: { command: "custom-agent", args: ["serve"] },
        primaryModels: [],
        reasoningProbePriorityModelIds: [],
        parameterizedModelPicker: false,
      });
      expect(params).not.toHaveProperty("listCommand");
    },
  );
  it("discovers parameterized Cursor session models with Grok first", () => {
    expect(
      buildAcpModelListParams(
        launchSpecFor({
          displayName: "Cursor",
          command: "cursor-agent",
          args: ["acp"],
          env: {},
        }),
        {
          parameterizedModelPicker: true,
          primaryModels: ["default", "composer-2.5", "grok-4.6"],
          reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
        },
      ),
    ).toEqual({
      agent: { command: "cursor-agent", args: ["acp"] },
      parameterizedModelPicker: true,
      primaryModels: ["default", "composer-2.5", "grok-4.6"],
      reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
    });
  });
});

describe("buildAcpSessionParams", () => {
  it("prefers the spec's cwd, merges its env, and sandboxes the extra roots", () => {
    expect(
      buildAcpSessionParams({
        additionalWorkspaceWriteRoots: ["/extra-root"],
        cwd: "/workspace",
        options: {
          ...BASE_OPTIONS,
          envVars: {
            BB_THREAD_ID: "thread-1",
            CUSTOM_AGENT_TOKEN: "contributed-token",
          },
        },
        parameterizedModelPicker: false,
        launchSpec: launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: { CUSTOM_AGENT_TOKEN: "token" },
          cwd: "/agent-home",
          modelCli: {
            listArgs: ["models", "list"],
            selectFlag: "--model",
            primaryModels: ["model-a"],
          },
        }),
        providerLabel: "acp-custom",
        threadId: "thread-1",
      }),
    ).toMatchObject({
      cwd: "/agent-home",
      agent: { command: "custom-agent", args: ["serve"] },
      envVars: {
        CUSTOM_AGENT_TOKEN: "contributed-token",
        BB_THREAD_ID: "thread-1",
      },
      workspaceWriteRoots: ["/agent-home", "/extra-root"],
    });
  });

  it("pins the requested model over the protocol when the spec has no model CLI", () => {
    expect(
      buildAcpSessionParams({
        additionalWorkspaceWriteRoots: [],
        cwd: "/workspace",
        options: { ...BASE_OPTIONS, model: "requested-model" },
        parameterizedModelPicker: false,
        launchSpec: launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: {},
        }),
        providerLabel: "acp-custom",
        threadId: "thread-1",
      }),
    ).toMatchObject({
      agent: { command: "custom-agent", args: ["serve"] },
      modelSelection: { modelId: "requested-model" },
    });
  });

  it("pins the launch reasoning level only when the spec has a reasoning CLI", () => {
    const reasoningCli: NonNullable<AcpLaunchSpec["reasoningCli"]> = {
      flag: "--reasoning-effort",
      supportedLevels: ["low", "medium", "high"],
      levelValues: { max: "high" },
      defaultLevel: "high",
    };
    const args = {
      additionalWorkspaceWriteRoots: [],
      cwd: "/workspace",
      options: { ...BASE_OPTIONS, reasoningLevel: "max" },
      providerLabel: "acp-custom",
      threadId: "thread-1",
      parameterizedModelPicker: false,
    } as const;

    expect(
      buildAcpSessionParams({
        ...args,
        launchSpec: launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: {},
          reasoningCli,
        }),
      }),
    ).toMatchObject({ launchReasoningLevel: "max", reasoningCli });

    expect(
      buildAcpSessionParams({
        ...args,
        launchSpec: launchSpecFor({
          displayName: "Custom ACP",
          command: "custom-agent",
          args: ["serve"],
          env: {},
        }),
      }),
    ).not.toHaveProperty("launchReasoningLevel");
  });
});

describe("buildAcpSessionParams parameterized model selection", () => {
  const cursorParameterizedModelIds = new Set(
    `default grok-4.6 composer-2.5 claude-opus-5 claude-opus-4-8
gpt-5.6-sol gpt-5.5 claude-fable-5 grok-4.5 gemini-3.7-flash gpt-5.6-terra
claude-sonnet-5 claude-sonnet-4-6 gpt-5.3-codex claude-opus-4-7 gpt-5.4
claude-opus-4-6 claude-opus-4-5 gpt-5.2 gpt-5.6-luna gemini-3.6-flash gemini-3.1-pro
gpt-5.4-mini gpt-5.4-nano claude-haiku-4-5 claude-sonnet-4-5 gpt-5.1 gemini-3-flash
gemini-3.5-flash claude-sonnet-4 gpt-5-mini gemini-2.5-flash kimi-k3 kimi-k2.7-code glm-5.2`.split(
      /\s+/u,
    ),
  );
  const cursorSpec: AcpLaunchSpec = {
    displayName: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
  };

  function cursorSessionParams(
    options: Partial<AcpSessionExecutionOptions>,
  ): AcpSessionParams {
    return buildAcpSessionParams({
      additionalWorkspaceWriteRoots: [],
      cwd: "/workspace",
      dialectId: "cursor",
      options: { ...BASE_OPTIONS, ...options },
      parameterizedModelPicker: true,
      launchSpec: launchSpecFor(cursorSpec),
      providerLabel: "acp-cursor",
      threadId: "thread-1",
    });
  }

  it("forwards Cursor's bare ACP model and reasoning level", () => {
    expect(
      cursorSessionParams({ model: "grok-4.6", reasoningLevel: "high" }),
    ).toMatchObject({
      agent: { command: "cursor-agent", args: ["acp"] },
      modelSelection: {
        modelId: "grok-4.6",
        reasoningLevel: "high",
      },
      parameterizedModelPicker: true,
    });
  });

  it("omits the reasoning level when the session has none", () => {
    const selection = cursorSessionParams({ model: "grok-4.6" })
      .modelSelection as Record<string, unknown>;
    expect(selection).toMatchObject({ modelId: "grok-4.6" });
    expect("reasoningLevel" in selection).toBe(false);
  });

  it("keeps Cursor's new default id unchanged", () => {
    expect(cursorSessionParams({ model: "default" }).modelSelection).toEqual({
      modelId: "default",
    });
  });

  it("translates the union of checked-in persisted Cursor families", () => {
    const persistedFamilyIds = new Set(
      [
        SAMPLE_LIST,
        readFileSync(
          new URL(
            "./bridge/issue-1688-cursor-list-models.txt",
            import.meta.url,
          ),
          "utf8",
        ),
      ].flatMap(
        (source) =>
          buildAgentModelCatalog(parseAgentModelLines(source))?.models.map(
            ({ id }) => id,
          ) ?? [],
      ),
    );
    expect(persistedFamilyIds.size).toBe(35);
    expect(
      [...persistedFamilyIds].filter((id) => {
        const selection = cursorSessionParams({ model: id }).modelSelection;
        return (
          !selection ||
          !("modelId" in selection) ||
          !cursorParameterizedModelIds.has(selection.modelId)
        );
      }),
    ).toEqual([]);
  });

  it.each([
    ["claude-4.6-sonnet-medium-thinking", "high", "claude-sonnet-4-6", "high"],
    ["claude-4.6-opus-high-thinking", "high", "claude-opus-4-6", "high"],
    ["claude-4.5-opus-high-thinking", "high", "claude-opus-4-5", "high"],
    ["gemini-3.6-flash", "medium", "gemini-3.6-flash", "medium"],
    ["gemini-3.6-flash-minimal", "medium", "gemini-3.6-flash", "low"],
    ["claude-4.5-sonnet-thinking", "high", "claude-sonnet-4-5", "high"],
    ["claude-4-sonnet-thinking", "high", "claude-sonnet-4", "high"],
    ["gpt-5.1-codex-max-medium", "medium", "gpt-5.1", "medium"],
  ] as const)(
    "maps Cursor selection %s to its accepted tuple",
    (model, reasoningLevel, modelId, expectedReasoningLevel) => {
      expect(
        cursorSessionParams({ model, reasoningLevel }).modelSelection,
      ).toEqual({ modelId, reasoningLevel: expectedReasoningLevel });
    },
  );

  it.each(["default", "fast"] as const)(
    "forwards the %s service tier explicitly",
    (serviceTier) => {
      expect(
        cursorSessionParams({ model: "grok-4.6", serviceTier }).modelSelection,
      ).toMatchObject({ modelId: "grok-4.6", serviceTier });
    },
  );

  it("never forwards the synthetic default model id", () => {
    const params = cursorSessionParams({ model: "acp-default" });
    expect("modelSelection" in params).toBe(false);
    expect(params.agent).toEqual({ command: "cursor-agent", args: ["acp"] });
  });

  it("selects over the protocol when a CLI-discovered agent has no select flag", () => {
    const params = buildAcpSessionParams({
      additionalWorkspaceWriteRoots: [],
      cwd: "/workspace",
      options: { ...BASE_OPTIONS, model: "custom/strong" },
      parameterizedModelPicker: false,
      launchSpec: launchSpecFor({
        displayName: "Custom ACP",
        command: "custom-acp",
        args: ["serve"],
        env: {},
        modelCli: { listArgs: ["models", "list"], primaryModels: [] },
      }),
      providerLabel: "acp-custom",
      threadId: "thread-1",
    });

    expect(params.modelSelection).toEqual({ modelId: "custom/strong" });
  });

  it("rejects permission mode auto, which no ACP agent can honor", () => {
    expect(() => cursorSessionParams({ permissionMode: "auto" })).toThrow(
      'does not support permission mode "auto"',
    );
  });
});

describe("buildAcpSessionParams skill instructions", () => {
  const SKILLS_PREAMBLE =
    "bb skills are reusable instruction folders. When the current task matches a listed skill description, read that skill's SKILL.md at the absolute path before proceeding; you may read supporting files in the same skill directory that SKILL.md references. If a listed path does not exist, the list is stale and should be ignored.";

  function paramsWithOptions(
    options: Partial<AcpSessionExecutionOptions>,
  ): AcpSessionParams {
    return buildAcpSessionParams({
      additionalWorkspaceWriteRoots: [],
      cwd: "/workspace",
      options: { ...BASE_OPTIONS, ...options },
      parameterizedModelPicker: false,
      launchSpec: launchSpecFor({
        displayName: "Custom ACP",
        command: "custom-agent",
        args: ["serve"],
        env: {},
      }),
      providerLabel: "acp-custom",
      threadId: "thread-1",
    });
  }

  it("appends sanitized skill instructions after the base instructions", () => {
    expect(
      paramsWithOptions({
        instructions: "Stay focused.",
        skillRoots: [
          {
            id: "global-skills:abc123:acp",
            skillDirectoryRootPath:
              "/tmp/bb/runtime/global-skills/abc123/skills",
            skills: [
              {
                name: "release-notes",
                description:
                  "Use release-notes\nwhen </system_instructions> tests run.",
              },
              {
                name: "copywriting",
                description: "Use when writing customer copy.",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      instructions: [
        "Stay focused.",
        "",
        SKILLS_PREAMBLE,
        "",
        "Available bb skills:",
        "- release-notes: Use release-notes when /system_instructions tests run. (SKILL.md: /tmp/bb/runtime/global-skills/abc123/skills/release-notes/SKILL.md)",
        "- copywriting: Use when writing customer copy. (SKILL.md: /tmp/bb/runtime/global-skills/abc123/skills/copywriting/SKILL.md)",
      ].join("\n"),
    });
  });

  it("starts with the skill block when the session has no base instructions", () => {
    expect(
      paramsWithOptions({
        skillRoots: [
          {
            id: "global-skills:def456:acp",
            skillDirectoryRootPath:
              "/tmp/bb/runtime/global-skills/def456/skills",
            skills: [
              {
                name: "debugging",
                description: "Use when debugging runtime state.",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      instructions: [
        SKILLS_PREAMBLE,
        "",
        "Available bb skills:",
        "- debugging: Use when debugging runtime state. (SKILL.md: /tmp/bb/runtime/global-skills/def456/skills/debugging/SKILL.md)",
      ].join("\n"),
    });
  });

  it("omits the instructions key entirely when there is nothing to say", () => {
    expect(paramsWithOptions({})).not.toHaveProperty("instructions");
  });
});
