import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { readPluginManifest } from "../../src/services/plugins/manifest.js";
import { testLogger } from "../helpers/test-app.js";
import { resolveProjectSkillSourceFromContent } from "../../src/services/skills/injected-skills.js";
import { resolveBuiltinSkillsRootPath } from "../../src/services/skills/builtin-skills-copy.js";

function skillDirectories(
  rootPath: string,
): ReadonlyArray<readonly [string, string]> {
  if (!existsSync(rootPath)) return [];
  return readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, path.join(rootPath, entry.name)] as const);
}

const pluginManifests = await Promise.all(
  listBundledPluginRegistrations().map((plugin) =>
    readPluginManifest(plugin.rootDir),
  ),
);
const SHIPPED_SKILLS = [
  ...skillDirectories(resolveBuiltinSkillsRootPath()),
  ...pluginManifests.flatMap((manifest) =>
    manifest.skillsRootPaths.flatMap(skillDirectories),
  ),
].sort(([left], [right]) => left.localeCompare(right));

function lineCount(text: string): number {
  return text.trimEnd().split("\n").length;
}

describe("shipped skills", () => {
  it.each(SHIPPED_SKILLS)(
    "%s has loadable metadata and routed reference files",
    (expectedName, skillRoot) => {
      const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
      const source = resolveProjectSkillSourceFromContent(testLogger, {
        candidatePath: skillRoot,
        content: skill,
        directoryName: expectedName,
      });

      expect(source).not.toBeNull();
      expect(source?.name).toBe(expectedName);
      expect(lineCount(skill)).toBeLessThanOrEqual(500);

      const referencesRoot = path.join(skillRoot, "references");
      const referenceFiles = existsSync(referencesRoot)
        ? readdirSync(referencesRoot, { withFileTypes: true })
        : [];
      expect(referenceFiles.every((entry) => entry.isFile())).toBe(true);

      const routedReferences = new Set(
        [...skill.matchAll(/references\/([a-z0-9][a-z0-9-]*\.md)/g)].map(
          (match) => match[1],
        ),
      );
      expect(routedReferences).toEqual(
        new Set(referenceFiles.map((entry) => entry.name)),
      );

      for (const reference of referenceFiles) {
        const content = readFileSync(
          path.join(referencesRoot, reference.name),
          "utf8",
        );
        expect(lineCount(content)).toBeLessThanOrEqual(500);
      }
    },
  );
});
