import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfiguredAcpAgents } from "./configured-agents.js";
import { acpProviderDeclaration } from "./declaration.js";
import { KNOWN_ACP_AGENTS, RESERVED_ACP_PROVIDER_IDS } from "./known-agents.js";
import { resolveAcpNativeRoots } from "./native-roots/index.js";

const reserved = RESERVED_ACP_PROVIDER_IDS;

function amp(displayName: string, command: string): unknown {
  return { id: "amp", displayName, command };
}

function shipped(id: string) {
  const agent = KNOWN_ACP_AGENTS.find((known) => known.id === id);
  if (agent === undefined) throw new Error(`no shipped agent ${id}`);
  return agent;
}

function onlyAgent(resolved: ReturnType<typeof resolveConfiguredAcpAgents>) {
  const [agent] = resolved.agents;
  if (agent === undefined || resolved.agents.length !== 1) {
    throw new Error(
      `expected exactly one agent, got ${resolved.agents.length}`,
    );
  }
  return agent;
}

describe("resolveConfiguredAcpAgents", () => {
  it("lets a setting entry win over the legacy entry with the same id", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([amp("Amp", "amp-next")]),
      legacyEntries: [amp("Amp (old)", "amp-old")],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toHaveLength(1);
    expect(resolved.agents[0]?.launch.command).toBe("amp-next");
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps a legacy-only agent and warns about it exactly once", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: "",
      legacyEntries: [amp("Amp", "amp-old")],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents.map((agent) => agent.id)).toEqual(["acp-amp"]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("deprecated customAcpAgents");
  });

  it("falls back to the legacy entries when the setting is not JSON", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: "[{ not json",
      legacyEntries: [amp("Amp", "amp-old")],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents.map((agent) => agent.id)).toEqual(["acp-amp"]);
    expect(resolved.warnings[0]).toContain("not valid JSON");
  });

  it("reports a setting that is JSON but not an array", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: '{"id":"amp"}',
      legacyEntries: [],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toEqual([]);
    expect(resolved.warnings[0]).toContain("must be a JSON array");
  });

  it("reports a reserved id from either source and drops that entry", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        { id: "cursor", displayName: "Mine", command: "mine" },
      ]),
      legacyEntries: [{ id: "cursor", displayName: "Old", command: "old" }],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toEqual([]);
    expect(resolved.warnings).toHaveLength(2);
    expect(resolved.warnings[0]).toContain('built-in provider "acp-cursor"');
    expect(resolved.warnings[1]).toContain('built-in provider "acp-cursor"');
  });

  it("accepts an entry that overrides an installed-only known agent", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        { id: "opencode", displayName: "opencode", command: "/opt/opencode" },
      ]),
      legacyEntries: [],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents.map((agent) => agent.id)).toEqual(["acp-opencode"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps a legacy entry's native skill roots and declares them", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: "",
      legacyEntries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          nativeSkillRoots: { user: [".amp/skills"], project: [".amp"] },
        },
      ],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    const [agent] = resolved.agents;
    if (agent === undefined) throw new Error("expected the agent to survive");
    expect(agent.launch.nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
    expect(acpProviderDeclaration(agent).experimental_nativeSkillRoots).toEqual(
      { user: [".amp/skills"], project: [".amp"] },
    );
  });

  it("reports a problem reading the deprecated file", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: "",
      legacyEntries: [],
      legacyProblem: "/home/u/.bb/config.json is not valid JSON",
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.warnings).toEqual([
      "Deprecated ACP agent config: /home/u/.bb/config.json is not valid JSON",
    ]);
  });
});

describe("a configured entry that replaces a shipped agent", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "bb-acp-configured-agents-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function replacing(entry: unknown) {
    return resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([entry]),
      legacyEntries: [],
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });
  }

  it("inherits the shipped agent's roots, with their options, and its resolver", async () => {
    const resolved = replacing({
      id: "grok",
      displayName: "Grok (private)",
      command: "/opt/grok-private",
    });
    const agent = onlyAgent(resolved);
    const grok = shipped("acp-grok");

    expect(resolved.warnings).toEqual([]);
    expect(agent.launch.command).toBe("/opt/grok-private");
    expect(agent.launch.nativeSkillRoots).toEqual(grok.launch.nativeSkillRoots);
    expect(agent.nativeRootsResolver).toBe(grok.nativeRootsResolver);

    const declaration = acpProviderDeclaration(agent);
    expect(declaration.experimental_nativeSkillRoots).toEqual({
      user: [{ path: ".agents/skills", recursive: true }],
      project: [
        { path: ".grok/skills", recursive: true, ancestors: true },
        { path: ".agents/skills", recursive: true, ancestors: true },
      ],
    });
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);

    const homeDir = path.join(tempRoot, "home");
    const answer = await resolveAcpNativeRoots({
      agentId: agent.id,
      cwd: null,
      homeDir,
      env: {},
    });
    expect(answer.skills?.map((root) => root.path)).toContain(
      path.join(homeDir, ".grok", "skills"),
    );
  });

  it("keeps the entry's own roots over the shipped ones and still resolves", () => {
    const agent = onlyAgent(
      replacing({
        id: "grok",
        displayName: "Grok (private)",
        command: "/opt/grok-private",
        nativeSkillRoots: { user: [".private/skills"], project: [] },
      }),
    );

    expect(agent.launch.nativeSkillRoots).toEqual({
      user: [".private/skills"],
      project: [],
    });
    expect(agent.nativeRootsResolver).toBe(
      shipped("acp-grok").nativeRootsResolver,
    );
    const declaration = acpProviderDeclaration(agent);
    expect(declaration.experimental_nativeSkillRoots).toEqual({
      user: [".private/skills"],
      project: [],
    });
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });

  it("gives a new id nothing to inherit", () => {
    const bare = onlyAgent(replacing(amp("Amp", "amp")));
    expect(bare.launch.nativeSkillRoots).toBeUndefined();
    expect(bare.nativeRootsResolver).toBeUndefined();
    const bareDeclaration = acpProviderDeclaration(bare);
    expect(bareDeclaration.experimental_nativeSkillRoots).toBeUndefined();
    expect(bareDeclaration.experimental_resolvesNativeRoots).toBeUndefined();

    const declared = onlyAgent(
      replacing({
        id: "amp",
        displayName: "Amp",
        command: "amp",
        nativeSkillRoots: { user: [".amp/skills"], project: [] },
      }),
    );
    expect(declared.launch.nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [],
    });
    expect(declared.nativeRootsResolver).toBeUndefined();
    expect(
      acpProviderDeclaration(declared).experimental_resolvesNativeRoots,
    ).toBeUndefined();
  });
});
