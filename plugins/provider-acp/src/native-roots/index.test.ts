import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpProviderDeclaration } from "../declaration.js";
import { KNOWN_ACP_AGENTS } from "../known-agents.js";
import { resolveAcpNativeRoots } from "./index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-acp-native-roots-index-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveAcpNativeRoots", () => {
  it("lists Cursor plugin skills", async () => {
    const homeDir = path.join(tempRoot, "home");
    const pluginRoot = path.join(tempRoot, "plugins", "review-tools");
    const installedPluginRoot = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "local",
      "review-tools",
    );
    await Promise.all([
      mkdir(path.join(pluginRoot, ".cursor-plugin"), { recursive: true }),
      mkdir(path.join(pluginRoot, "skills", "review"), { recursive: true }),
      mkdir(path.dirname(installedPluginRoot), { recursive: true }),
    ]);
    await writeFile(
      path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "review-tools", skills: "./skills/" }),
      "utf8",
    );
    await symlink(pluginRoot, installedPluginRoot, "dir");
    await writeFile(
      path.join(pluginRoot, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n",
      "utf8",
    );

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-cursor",
      cwd: path.join(tempRoot, "workspace"),
      homeDir,
      env: {},
    });

    expect(answer.skills).toEqual([
      {
        path: path.join(installedPluginRoot, "skills"),
        origin: "user",
        namePrefix: "review-tools:",
        shape: "skills",
      },
    ]);
  });

  it("lists conventional skills from a portable Cursor plugin", async () => {
    const homeDir = path.join(tempRoot, "home");
    const pluginRoot = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "local",
      "scott-engineering",
    );
    await mkdir(path.join(pluginRoot, "skills", "code-review"), {
      recursive: true,
    });
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "scott-engineering" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "skills", "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: Review code\n---\n",
      "utf8",
    );

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-cursor",
      cwd: path.join(tempRoot, "workspace"),
      homeDir,
      env: {},
    });

    expect(answer.skills).toEqual([
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix: "scott-engineering:",
        shape: "skills",
      },
    ]);
  });

  it("lists skills from a completed Cursor marketplace cache entry", async () => {
    const homeDir = path.join(tempRoot, "home");
    const pluginRoot = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "cache",
      "cursor-public",
      "review-tools",
      "revision-one",
    );
    await mkdir(path.join(pluginRoot, ".cursor-plugin"), { recursive: true });
    await mkdir(path.join(pluginRoot, "skills", "review"), {
      recursive: true,
    });
    await writeFile(path.join(pluginRoot, ".cache-complete"), "", "utf8");
    await writeFile(
      path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "review-tools", skills: "./skills/" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n",
      "utf8",
    );

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-cursor",
      cwd: path.join(tempRoot, "workspace"),
      homeDir,
      env: {},
    });

    expect(answer.skills).toEqual([
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix: "review-tools:",
        shape: "skills",
      },
    ]);
  });

  it("uses the newest completed Cursor marketplace plugin revision", async () => {
    const homeDir = path.join(tempRoot, "home");
    const pluginCache = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "cache",
      "cursor-public",
      "review-tools",
    );
    const olderRoot = path.join(pluginCache, "older");
    const newerRoot = path.join(pluginCache, "newer");
    const incompleteRoot = path.join(pluginCache, "incomplete");
    for (const pluginRoot of [olderRoot, newerRoot, incompleteRoot]) {
      await mkdir(path.join(pluginRoot, "skills", "review"), {
        recursive: true,
      });
      await writeFile(
        path.join(pluginRoot, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf8",
      );
      await writeFile(
        path.join(pluginRoot, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review code\n---\n",
        "utf8",
      );
    }
    const olderMarker = path.join(olderRoot, ".cache-complete");
    const newerMarker = path.join(newerRoot, ".cache-complete");
    await writeFile(olderMarker, "", "utf8");
    await writeFile(newerMarker, "", "utf8");
    await utimes(olderMarker, new Date(1_000), new Date(1_000));
    await utimes(newerMarker, new Date(2_000), new Date(2_000));

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-cursor",
      cwd: null,
      homeDir,
      env: {},
    });

    expect(answer.skills?.map((root) => root.path)).toEqual([
      path.join(newerRoot, "skills"),
    ]);
  });

  it("deduplicates a local link to a cached Cursor plugin", async () => {
    const homeDir = path.join(tempRoot, "home");
    const pluginRoot = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "cache",
      "cursor-public",
      "review-tools",
      "revision-one",
    );
    const localPluginRoot = path.join(
      homeDir,
      ".cursor",
      "plugins",
      "local",
      "review-tools",
    );
    await mkdir(path.join(pluginRoot, "skills", "review"), {
      recursive: true,
    });
    await mkdir(path.dirname(localPluginRoot), { recursive: true });
    await writeFile(path.join(pluginRoot, ".cache-complete"), "", "utf8");
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "review-tools" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n",
      "utf8",
    );
    await symlink(pluginRoot, localPluginRoot, "dir");

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-cursor",
      cwd: null,
      homeDir,
      env: {},
    });

    expect(answer.skills).toEqual([
      {
        path: path.join(localPluginRoot, "skills"),
        origin: "user",
        namePrefix: "review-tools:",
        shape: "skills",
      },
    ]);
  });

  it("answers for the agent asked and nothing for the rest", async () => {
    const homeDir = path.join(tempRoot, "home");
    const args = { cwd: null, homeDir, env: { OPENCODE_CONFIG_DIR: "oc" } };

    const opencode = await resolveAcpNativeRoots({
      ...args,
      agentId: "acp-opencode",
    });
    expect(opencode.skills?.map((root) => root.path)).toEqual([
      path.join(homeDir, ".config", "opencode", "skills"),
      path.join(homeDir, "oc", "skills"),
    ]);
    expect(
      await resolveAcpNativeRoots({ ...args, agentId: "acp-cursor" }),
    ).toEqual({ skills: [], commands: [] });
    expect(
      await resolveAcpNativeRoots({ ...args, agentId: "acp-amp" }),
    ).toEqual({});
  });

  it("drops only the root the contract refuses, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const homeDir = path.join(tempRoot, "home");
    const pluginRoot = path.join(homeDir, ".grok", "plugins", "bad name");
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await mkdir(path.join(homeDir, ".grok"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".grok", "config.toml"),
      '[plugins]\nenabled = ["bad name"]\n',
      "utf8",
    );

    const answer = await resolveAcpNativeRoots({
      agentId: "acp-grok",
      cwd: null,
      homeDir,
      env: {},
    });
    expect(answer.skills?.map((root) => root.path)).toEqual([
      path.join(homeDir, ".grok", "skills"),
      path.join(homeDir, ".claude", "skills"),
      path.join(homeDir, ".cursor", "skills"),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `dropped the skills root "${path.join(pluginRoot, "skills")}"`,
    );
  });
});

describe("known agent declarations", () => {
  it("declares the resolver flag exactly for the agents that carry one", () => {
    const resolving = KNOWN_ACP_AGENTS.filter(
      (agent) =>
        acpProviderDeclaration(agent).experimental_resolvesNativeRoots === true,
    ).map((agent) => agent.id);
    expect(resolving).toEqual([
      "acp-cursor",
      "acp-opencode",
      "acp-omp",
      "acp-grok",
      "acp-hermes-agent",
    ]);
    expect(
      KNOWN_ACP_AGENTS.every(
        (agent) =>
          (agent.nativeRootsResolver !== undefined) ===
          resolving.includes(agent.id),
      ),
    ).toBe(true);
  });

  it("passes root options through to the declaration unchanged", () => {
    const cursor = KNOWN_ACP_AGENTS.find((agent) => agent.id === "acp-cursor");
    const grok = KNOWN_ACP_AGENTS.find((agent) => agent.id === "acp-grok");
    if (cursor === undefined || grok === undefined)
      throw new Error("missing agent");

    const cursorRoots =
      acpProviderDeclaration(cursor).experimental_nativeSkillRoots;
    for (const side of [cursorRoots?.user ?? [], cursorRoots?.project ?? []]) {
      expect(side).toHaveLength(4);
      expect(
        side.every(
          (root) => typeof root === "object" && root.recursive === true,
        ),
      ).toBe(true);
    }
    expect(acpProviderDeclaration(grok).experimental_nativeSkillRoots).toEqual({
      user: [{ path: ".agents/skills", recursive: true }],
      project: [
        { path: ".grok/skills", recursive: true, ancestors: true },
        { path: ".agents/skills", recursive: true, ancestors: true },
      ],
    });
  });
});
