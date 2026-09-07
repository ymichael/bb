import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SKILL_PLUGIN_NAME,
  createClaudeSkillPluginsRoot,
  ensureClaudeSkillPlugin,
} from "../skill-plugins.js";

describe("claude skill plugins", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "bb-claude-skill-plugins-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function stageSkills(name: string): string {
    const root = join(baseDir, `stage-${name}`, "skills");
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(
      join(root, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n",
    );
    return root;
  }

  it("assembles a plugin whose skills directory links to the generic root", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const skillsPath = stageSkills("a");
    const pluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "global-skills:abc123", path: skillsPath },
    });

    expect(pluginPath.startsWith(pluginsRoot)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; skills: string };
    expect(manifest.skills).toBe("./skills");
    expect(manifest.name).toBe(CLAUDE_SKILL_PLUGIN_NAME);
    expect(lstatSync(join(pluginPath, "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginPath, "skills"))).toBe(skillsPath);
    expect(
      readFileSync(join(pluginPath, "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("name: demo");
  });

  it("is idempotent for a root and re-points the link when the root moves", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const first = stageSkills("a");
    const second = stageSkills("b");
    const pluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "r", path: first },
    });
    expect(
      ensureClaudeSkillPlugin({ pluginsRoot, root: { id: "r", path: first } }),
    ).toBe(pluginPath);
    expect(readlinkSync(join(pluginPath, "skills"))).toBe(first);

    const movedPluginPath = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "r", path: second },
    });
    expect(movedPluginPath).not.toBe(pluginPath);
    expect(readlinkSync(join(movedPluginPath, "skills"))).toBe(second);
  });

  it("keeps the stable name across catalog changes and suffixes only a colliding second root", () => {
    const pluginsRoot = createClaudeSkillPluginsRoot(baseDir);
    const first = stageSkills("a");
    const second = stageSkills("b");
    const nameOf = (pluginPath: string): string =>
      (
        JSON.parse(
          readFileSync(
            join(pluginPath, ".claude-plugin", "plugin.json"),
            "utf8",
          ),
        ) as { name: string }
      ).name;

    expect(
      nameOf(
        ensureClaudeSkillPlugin({
          pluginsRoot,
          root: { id: "global-skills:aaaa", path: first },
        }),
      ),
    ).toBe(CLAUDE_SKILL_PLUGIN_NAME);
    expect(
      nameOf(
        ensureClaudeSkillPlugin({
          pluginsRoot,
          root: { id: "global-skills:bbbb", path: second },
        }),
      ),
    ).toBe(CLAUDE_SKILL_PLUGIN_NAME);

    const takenNames = new Map<string, string>();
    const a = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "global-skills:aaaa", path: first },
      takenNames,
    });
    const b = ensureClaudeSkillPlugin({
      pluginsRoot,
      root: { id: "global-skills:bbbb", path: second },
      takenNames,
    });
    expect(nameOf(a)).toBe(CLAUDE_SKILL_PLUGIN_NAME);
    expect(nameOf(b)).toMatch(/^bb-global-skills-[0-9a-f]{8}$/u);
  });
});
