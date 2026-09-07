import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { derivePluginId } from "@bb/domain";

const skillRoot = fileURLToPath(
  new URL(
    "../../src/services/skills/builtin-skills/submit-a-plugin/",
    import.meta.url,
  ),
);
const skillPath = path.join(skillRoot, "SKILL.md");
const deriveIdScriptPath = path.join(
  skillRoot,
  "scripts",
  "derive-plugin-id.mjs",
);
const skillReferencePaths = [
  "marketplace-entry.md",
  "plugin-release.md",
  "pull-request.md",
].map((name) => path.join(skillRoot, "references", name));
const tempDirs: string[] = [];

async function readSkillTree(): Promise<string> {
  return (
    await Promise.all(
      [skillPath, ...skillReferencePaths].map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
}

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bb-submit-plugin-"));
  tempDirs.push(directory);
  return directory;
}

async function deriveWithSkill(packageName: string): Promise<string> {
  const directory = await makeTempDir();
  const manifestPath = path.join(directory, "package.json");
  await writeFile(manifestPath, JSON.stringify({ name: packageName }), "utf8");
  return execFileSync(process.execPath, [deriveIdScriptPath, manifestPath], {
    encoding: "utf8",
  }).trim();
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("submit-a-plugin skill", () => {
  it("derives dotted and underscored package ids with the product algorithm", async () => {
    for (const packageName of [
      "@acme/bb-plugin-release.notes",
      "@acme/bb-plugin-release_notes",
      "bb_plugin_notes",
    ]) {
      await expect(deriveWithSkill(packageName)).resolves.toBe(
        derivePluginId(packageName),
      );
    }
  });

  it("does not execute package metadata while it derives an id", async () => {
    const directory = await makeTempDir();
    const markerPath = path.join(directory, "metadata-executed");
    const manifestPath = path.join(directory, "package.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ name: "bb-plugin-notes$(touch metadata-executed)" }),
      "utf8",
    );

    expect(
      execFileSync(process.execPath, [deriveIdScriptPath, manifestPath], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe(derivePluginId("bb-plugin-notes$(touch metadata-executed)"));
    expect(existsSync(markerPath)).toBe(false);
  });

  it("keeps release commands behind approval and disables npm lifecycle scripts", async () => {
    const skill = await readSkillTree();

    expect(skill).toContain("A submission request does not approve a release.");
    expect(skill).toContain("npm ci --ignore-scripts");
    expect(skill).toContain("npm pack --dry-run --ignore-scripts");
    expect(skill).toContain("npm publish --ignore-scripts");
    expect(skill).not.toContain("PLUGIN_DISPLAY_NAME");
  });

  it("captures screenshots with a harness tool and falls back to the user", async () => {
    const skill = await readSkillTree();

    expect(skill).toContain(
      "Use a browser or computer automation tool that the current harness supplies.",
    );
    expect(skill).toContain(
      "If the harness supplies no such tool, ask the user for the images.",
    );
    expect(skill).toContain("at least 1200 pixels wide");
    expect(skill).toContain("at or below 2 MiB");
    expect(skill).toContain("a maximum of six");
  });

  it("requires an overview file on every public marketplace entry", async () => {
    const skill = await readSkillTree();

    expect(skill).toContain(
      "Every entry in the public marketplace needs an overview file.",
    );
    expect(skill).toContain(
      "marketplace requires an overview file on every entry.",
    );
    expect(skill).toContain(
      "draft one from the behavior you observed while validating and screenshotting",
    );
    expect(skill).not.toContain("when the entry has no overview file");
    expect(skill).toContain("Copy the file to overview/<plugin-id>.md");
    expect(skill).toContain('"overview": "./overview/notes.md"');
    expect(skill).toContain("a maximum of 4000 characters");
    expect(skill).toContain("Each link must be an absolute https URL.");
    expect(skill).toContain(
      "The build rejects raw HTML, images, tables, footnotes, task lists, and control",
    );
    expect(skill).toContain("git add overview/PLUGIN_ID.md");
  });

  it("states the entry quality rules the store UI depends on", async () => {
    const skill = await readSkillTree();

    expect(skill).toContain("Write an App Store listing, not a README line.");
    expect(skill).toContain(
      "Do not use these words: powerful, seamless, easy, simple, fast, best, modern,",
    );
    expect(skill).toContain("clamps the description to two lines in a");
    expect(skill).toContain(
      "Marketplace CI refuses a new or changed entry with no category.",
    );
    expect(skill).toContain("The entry has no engines field");
  });

  it("provides a local submission path without gh", async () => {
    const skill = await readSkillTree();

    expect(skill).toContain("If gh is unavailable or authentication fails");
    expect(skill).toContain(
      "git clone https://github.com/get-bb/marketplace.git /SAFE/NEW/PATH/marketplace",
    );
    expect(skill).toMatch(
      /Return their paths, the clone path,\s+branch name, and results\./,
    );
  });
});
