import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export const PI_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".pi/agent/skills", ".agents/skills"],
    project: [".pi/skills", ".agents/skills"],
  },
  experimental_resolvesNativeRoots: true,
};

const piSettingsSchema = z
  .object({ skills: z.array(z.string()).optional() })
  .passthrough();

const DEFAULT_AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;

export interface ResolvePiNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

function resolvePiAgentDir(args: ResolvePiNativeRootsArgs): string {
  const configured = args.env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolveStoredPath(args.homeDir, configured, args.homeDir)
    : path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS);
}

function resolveStoredPath(
  homeDir: string,
  value: string,
  baseDir: string,
): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isPlainSkillSource(value: string): boolean {
  return !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value);
}

export async function resolvePiNativeRoots(
  args: ResolvePiNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const agentDir = resolvePiAgentDir(args);
  const roots = new Set<string>();
  if (agentDir !== path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS)) {
    roots.add(path.resolve(agentDir, "skills"));
  }
  let settings: z.infer<typeof piSettingsSchema> | null = null;
  try {
    settings = piSettingsSchema.parse(
      JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")),
    );
  } catch {
    settings = null;
  }
  for (const raw of settings?.skills ?? []) {
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.startsWith("!") ||
      !isPlainSkillSource(value)
    ) {
      continue;
    }
    if (path.extname(value).toLowerCase() === ".md") {
      continue;
    }
    roots.add(path.resolve(resolveStoredPath(args.homeDir, value, agentDir)));
  }
  return {
    skills: experimental_filterResolvedNativeRoots(
      {
        skills: [...roots].sort().map((rootPath) => ({
          path: rootPath,
          origin: "user" as const,
          shape: "skills" as const,
        })),
      },
      { warn: console.warn },
    ).answer.skills,
  };
}
