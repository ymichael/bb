import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePiNativeRoots } from "./native-roots.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-pi-native-roots-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(agentDir: string, settings: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

async function resolvedSkillPaths(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const answer = await resolvePiNativeRoots({ homeDir, env });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.commands).toEqual([]);
  for (const root of parsed.skills) {
    expect(root).toMatchObject({
      origin: "user",
      shape: "skills",
      namePrefix: "",
    });
  }
  return parsed.skills.map((root) => root.path);
}

it("answers empty without a settings file or with an unreadable one", async () => {
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), "{not json");
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
});

it("resolves plain skill entries against home, the agent dir, or as given, and drops the rest", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/team-skills",
      "~/shared/skills",
      "local-skills/",
      "team/one-skill/SKILL.md",
      "notes/single-skill.md",
      "!disabled-pattern",
      "npm:@acme/pi-skills",
      "git:github.com/acme/skills",
      "https://example.invalid/skills",
      "  ",
      "/opt/team-skills",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      "/opt/team-skills",
      join(homeDir, ".pi", "agent", "local-skills"),
      join(homeDir, "shared", "skills"),
    ].sort(),
  );
});

it("adds the moved agent dir's skills directory when PI_CODING_AGENT_DIR points elsewhere", async () => {
  const agentDir = join(homeDir, "custom-agent");
  writeSettings(agentDir, { skills: [] });
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: agentDir }),
  ).resolves.toEqual([join(agentDir, "skills")]);
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
  ).resolves.toEqual([join(agentDir, "skills")]);
});

it("never answers a root the contract would refuse", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/../etc/skills",
      "/opt//skills",
      "relative/../escape",
      "/srv/skills/",
      "~/team-skills//",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      "/etc/skills",
      "/opt/skills",
      join(homeDir, ".pi", "agent", "escape"),
      "/srv/skills",
      join(homeDir, "team-skills"),
    ].sort(),
  );
});
