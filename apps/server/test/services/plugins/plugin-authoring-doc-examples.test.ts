import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SKILL_ROOT = fileURLToPath(
  new URL(
    "../../../src/services/skills/builtin-skills/bb-plugin-authoring/",
    import.meta.url,
  ),
);

function readSkillTree(directory = SKILL_ROOT): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return readSkillTree(entryPath);
      return entry.name.endsWith(".md") ? readFileSync(entryPath, "utf8") : [];
    })
    .join("\n");
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const pluginSdkEntry = join(
  repoRoot,
  "packages",
  "plugin-sdk",
  "src",
  "index.ts",
);
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

interface SdkReference {
  path: string;
  line: number;
}

interface SdkFence {
  mode: "function" | "create-thread-handler";
  source: string;
  line: number;
}

const SDK_CALL = /bb\.sdk\.([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)\s*\(/g;
const SDK_CALL_IN_SOURCE = /bb\.sdk\.[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*\s*\(/;
const TYPESCRIPT_FENCE = /```(?:ts|typescript)([^\n]*)\n([\s\S]*?)```/g;

function skillLine(skill: string, index: number): number {
  return skill.slice(0, index).split("\n").length;
}

function sdkReferences(skill: string): SdkReference[] {
  const found = new Map<string, SdkReference>();
  for (const match of skill.matchAll(SDK_CALL)) {
    const path = match[1];
    if (path === undefined) continue;
    found.set(path, { path, line: skillLine(skill, match.index) });
  }
  return [...found.values()];
}

function sdkFences(skill: string): SdkFence[] {
  const found: SdkFence[] = [];
  for (const match of skill.matchAll(TYPESCRIPT_FENCE)) {
    const [, rawMode, source] = match;
    if (source === undefined || !SDK_CALL_IN_SOURCE.test(source)) continue;
    const mode = rawMode?.trim() ?? "";
    if (mode !== "" && mode !== "create-thread-handler") {
      throw new Error(`Unsupported SDK example mode: ${mode}`);
    }
    found.push({
      mode: mode === "create-thread-handler" ? mode : "function",
      source,
      line: skillLine(skill, match.index),
    });
  }
  return found;
}

function typeIndex(path: string): string {
  return path
    .split(".")
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join("");
}

function probeSource(
  references: readonly SdkReference[],
  fences: readonly SdkFence[],
): string {
  return [
    `import type { BbPluginApi } from "@get-bb/plugin-sdk";`,
    `type Sdk = BbPluginApi["sdk"];`,
    `type Callable = (...args: never[]) => unknown;`,
    `type AssertCallable<F extends Callable> = F;`,
    ...references.map(
      (reference) =>
        `type SdkReferenceAtLine${reference.line} = AssertCallable<Sdk${typeIndex(reference.path)}>;`,
    ),
    `declare const bb: BbPluginApi;`,
    `type SpawnArgs = Parameters<Sdk["threads"]["spawn"]>[0];`,
    `declare const projectId: SpawnArgs["projectId"];`,
    `declare const threadId: Parameters<Sdk["threads"]["get"]>[0]["threadId"];`,
    `type CreateThreadInput = { request: SpawnArgs; sectionId?: SpawnArgs["sectionId"] };`,
    ...fences.flatMap((fence) =>
      fence.mode === "create-thread-handler"
        ? [
            `const skillExampleAtLine${fence.line}: { createThread(input: CreateThreadInput): unknown } = {`,
            fence.source,
            `};`,
          ]
        : [
            `async function skillExampleAtLine${fence.line}() {`,
            fence.source,
            `}`,
          ],
    ),
  ].join("\n");
}

const PROBE_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
    types: [],
    paths: { "@get-bb/plugin-sdk": [pluginSdkEntry] },
  },
  files: ["probe.ts"],
};

describe("bb-plugin-authoring skill examples", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-doc-examples-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves every SDK reference and compiles every TypeScript example", async () => {
    const skill = readSkillTree();
    const references = sdkReferences(skill);
    const fences = sdkFences(skill);
    expect(references.length).toBeGreaterThan(0);
    expect(fences.length).toBeGreaterThan(0);

    await writeFile(
      join(workDir, "probe.ts"),
      `${probeSource(references, fences)}\n`,
      "utf8",
    );
    await writeFile(
      join(workDir, "tsconfig.json"),
      `${JSON.stringify(PROBE_TSCONFIG, null, 2)}\n`,
      "utf8",
    );

    const result = spawnSync(tsc, ["--project", workDir], { encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }, 60_000);
});
