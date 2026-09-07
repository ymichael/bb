import { describe, expect, it } from "vitest";
import {
  customAcpAgentDefinition,
  formatCustomAcpProviderId,
  parseCustomAcpAgents,
  type CustomAcpAgent,
} from "./agents.js";
import { acpProviderDeclaration } from "./declaration.js";
import { KNOWN_ACP_AGENTS, RESERVED_ACP_PROVIDER_IDS } from "./known-agents.js";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";

const reserved = RESERVED_ACP_PROVIDER_IDS;

describe("parseCustomAcpAgents", () => {
  it("keeps a well-formed agent and defaults what it left out", () => {
    const parsed = parseCustomAcpAgents({
      entries: [{ id: "amp", displayName: "Amp", command: "amp" }],
      reservedProviderIds: reserved,
    });

    expect(parsed.problems).toEqual([]);
    expect(parsed.agents).toEqual([
      {
        id: "amp",
        displayName: "Amp",
        command: "amp",
        args: [],
        env: {},
        supportsManualCompaction: false,
      },
    ]);
  });

  it("reports a malformed entry, a shadowed built-in, and a duplicate", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        { id: "Bad Slug", displayName: "x", command: "x" },
        { id: "cursor", displayName: "Mine", command: "mine" },
        { id: "amp", displayName: "Amp", command: "amp" },
        { id: "amp", displayName: "Amp again", command: "amp" },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents.map((agent) => agent.id)).toEqual(["amp"]);
    expect(parsed.problems).toHaveLength(3);
    expect(parsed.problems[1]).toContain(
      'resolves to built-in provider "acp-cursor"',
    );
    expect(parsed.problems[2]).toContain("configured more than once");
  });

  it("rejects the legacy logo field the setting never had", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          logo: "/home/user/amp.svg",
        },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents).toEqual([]);
    expect(parsed.problems[0]).toContain("is not a valid agent");
  });

  it("only accepts entries whose launch spec the bridge will parse", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          args: ["acp"],
          env: { AMP_TOKEN: "x" },
          modelCli: { listArgs: ["--models"], primaryModels: ["amp-1"] },
          reasoningCli: {
            flag: "--effort",
            supportedLevels: ["low", "high"],
            levelValues: { low: "cheap", high: "deep" },
            defaultLevel: "high",
          },
          nativeReasoning: {
            configId: "effort",
            supportedLevels: ["medium"],
            levelValues: { medium: "balanced" },
          },
          nativeSkillRoots: { user: [".amp/skills"], project: [".amp"] },
          permissionCli: { full: ["--dangerous"] },
        },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.problems).toEqual([]);
    const [agent] = parsed.agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    const launch = customAcpAgentDefinition(agent).launch;
    expect(experimental_acpLaunchSpecSchema.safeParse(launch).success).toBe(
      true,
    );
    expect(launch.nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
  });

  it.each([
    ["an absolute skill root", { nativeSkillRoots: { user: ["/etc/skills"] } }],
    [
      "a level outside bb's ladder",
      { reasoningCli: { flag: "-e", supportedLevels: ["turbo"] } },
    ],
    [
      "a default level it does not support",
      {
        reasoningCli: {
          flag: "-e",
          supportedLevels: ["low"],
          defaultLevel: "high",
        },
      },
    ],
    ["an unknown skill-root shape", { nativeSkillRoots: { argFlag: "-s" } }],
  ])("rejects %s", (_label, extra) => {
    const parsed = parseCustomAcpAgents({
      entries: [{ id: "amp", displayName: "Amp", command: "amp", ...extra }],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
  });
});

describe("customAcpAgentDefinition", () => {
  it("carries the launch spec and drops a model CLI with nothing to list", () => {
    const [agent] = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          args: ["acp"],
          env: { AMP_TOKEN: "x" },
          cwd: "/srv/amp",
          modelCli: { listArgs: [], primaryModels: [] },
          supportsManualCompaction: true,
        },
      ],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    const definition = customAcpAgentDefinition(agent);

    expect(definition.id).toBe(formatCustomAcpProviderId("amp"));
    expect(definition.launch).toEqual({
      displayName: "Amp",
      command: "amp",
      args: ["acp"],
      env: { AMP_TOKEN: "x" },
      cwd: "/srv/amp",
    });
    expect(definition.supportsManualCompaction).toBe(true);
    expect(definition.fork).toBe("none");
  });
});

describe("acpProviderDeclaration", () => {
  it("declares a configured agent's native skill roots", () => {
    const [agent] = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          nativeSkillRoots: { user: [".amp/skills"], project: [".amp"] },
        },
      ],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error("expected the agent to parse");

    const declaration = acpProviderDeclaration(customAcpAgentDefinition(agent));
    expect(declaration.experimental_nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
  });

  it("declares no skill roots for an agent that names none", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      if (agent.launch.nativeSkillRoots !== undefined) continue;
      expect(
        acpProviderDeclaration(agent).experimental_nativeSkillRoots,
      ).toBeUndefined();
    }
  });

  it("groups every agent under the acp family instead of an id prefix", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      expect(acpProviderDeclaration(agent).family).toBe("acp");
    }
  });

  it("declares each known agent's own fork support and dialect", () => {
    const byId = new Map(
      KNOWN_ACP_AGENTS.map((agent) => [
        agent.id,
        acpProviderDeclaration(agent),
      ]),
    );

    expect(byId.get("acp-cursor")?.capabilities.fork).toBe("none");
    expect(byId.get("acp-grok")?.capabilities.fork).toBe("none");
    expect(byId.get("acp-opencode")?.capabilities.fork).toBe("tip");
    expect(byId.get("acp-cursor")?.experimental_bridgeOptions).toMatchObject({
      acpDialect: "cursor",
      parameterizedModelPicker: true,
      primaryModels: [
        "default",
        "grok-4.6",
        "gpt-5.6-sol",
        "claude-opus-5",
        "claude-fable-5",
        "composer-2.5",
      ],
      reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
      acpLaunchSpec: {
        command: "cursor-agent",
        args: ["acp"],
        modelCli: {
          listArgs: ["--list-models"],
          primaryModels: [],
        },
      },
    });
    expect(byId.get("acp-grok")?.experimental_bridgeOptions).toMatchObject({
      acpDialect: "grok",
    });
    expect(byId.get("acp-opencode")?.experimental_bridgeOptions).toMatchObject({
      acpDialect: "opencode",
    });
    expect(
      byId.get("acp-opencode")?.capabilities.supportsManualCompaction,
    ).toBe(true);
    expect(byId.get("acp-cursor")?.capabilities.supportsManualCompaction).toBe(
      false,
    );
  });

  it("keeps each agent's own reasoning ladder and installed-only visibility", () => {
    const grok = acpProviderDeclaration(
      KNOWN_ACP_AGENTS.find((agent) => agent.id === "acp-grok")!,
    );
    expect(grok.capabilities.reasoningLevels).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(grok.experimental_visibility).toBe("installed");

    const cursor = acpProviderDeclaration(
      KNOWN_ACP_AGENTS.find((agent) => agent.id === "acp-cursor")!,
    );
    expect(cursor.capabilities.reasoningLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(cursor.experimental_visibility).toBeUndefined();
    expect(cursor.maintenance?.usage).toBe(true);
    expect(cursor.maintenance?.installation).toBe(true);
  });

  it("gives a configured agent honest copy when it names no sign-in command", () => {
    const declaration = acpProviderDeclaration(
      customAcpAgentDefinition({
        id: "amp",
        displayName: "Amp",
        command: "amp",
        args: [],
        env: {},
        supportsManualCompaction: false,
      }),
    );

    expect(declaration.strings?.signInHint).toBe(
      "Sign in to Amp on the machine, then reload.",
    );
    expect(declaration.maintenance?.usage).toBe(false);
  });
});
