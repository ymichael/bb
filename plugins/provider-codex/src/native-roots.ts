import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalNativeRootsResolveAnswer,
  type ExperimentalVendorPlugin,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { resolveCodexHome } from "./codex-home.js";

export const CODEX_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".codex/skills", ".agents/skills"],
    project: [".codex/skills", { path: ".agents/skills", ancestors: true }],
  },
  experimental_resolvesNativeRoots: true,
};

export type CodexResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

export interface ResolveCodexNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

const CODEX_PLUGIN_DIR_NAME = ".codex-plugin";
const CODEX_PLUGIN_MANIFEST_FILE_NAME = "plugin.json";
const CODEX_CONFIG_FILE_NAME = "config.toml";

const pluginPathListSchema = z.union([z.string(), z.array(z.string())]);

const codexPluginManifestSchema = z
  .object({
    name: z.string().min(1).optional(),
    skills: pluginPathListSchema.optional(),
  })
  .passthrough();
type CodexPluginManifest = z.infer<typeof codexPluginManifestSchema>;

interface PluginCacheCandidate {
  modifiedAtMs: number;
  rootPath: string;
}

export async function resolveCodexNativeRoots(
  args: ResolveCodexNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const codexHome = resolveCodexHome(args.homeDir, args.env);
  const skillsRootPath = path.join(codexHome, "skills");
  const skills: CodexResolvedSkillRoot[] = [
    { path: skillsRootPath, origin: "user", shape: "skills" },
    {
      path: path.join(skillsRootPath, ".system"),
      origin: "user",
      shape: "skills",
    },
    ...(await resolveCodexPluginSkillRoots(codexHome)),
  ];
  return {
    skills: experimental_filterResolvedNativeRoots(
      { skills },
      { warn: console.warn },
    ).answer.skills,
  };
}

function decodeTomlBasicString(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index === value.length - 1) {
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = value[index];
    if (escaped === "n") {
      decoded += "\n";
      continue;
    }
    if (escaped === "r") {
      decoded += "\r";
      continue;
    }
    if (escaped === "t") {
      decoded += "\t";
      continue;
    }
    decoded += escaped;
  }
  return decoded;
}

export function readCodexEnabledPluginSettingsFromToml(
  content: string,
): ReadonlyMap<string, boolean> {
  const enabledPlugins = new Map<string, boolean>();
  let currentPluginId: string | null = null;

  for (const line of content.split(/\r?\n/u)) {
    const sectionMatch = line.match(
      /^\s*\[plugins\.(?:"((?:\\.|[^"\\])*)"|([^\]\s]+))\]\s*(?:#.*)?$/u,
    );
    if (sectionMatch) {
      currentPluginId =
        sectionMatch[1] !== undefined
          ? decodeTomlBasicString(sectionMatch[1])
          : (sectionMatch[2] ?? null);
      continue;
    }

    if (/^\s*\[/u.test(line)) {
      currentPluginId = null;
      continue;
    }

    if (currentPluginId === null) {
      continue;
    }
    const enabledMatch = line.match(
      /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u,
    );
    if (enabledMatch) {
      enabledPlugins.set(currentPluginId, enabledMatch[1] === "true");
    }
  }

  return enabledPlugins;
}

async function readCodexEnabledPluginSettings(
  codexHome: string,
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return readCodexEnabledPluginSettingsFromToml(
      await fs.readFile(path.join(codexHome, CODEX_CONFIG_FILE_NAME), "utf8"),
    );
  } catch {
    return new Map<string, boolean>();
  }
}

async function directoryHasCodexPluginManifest(
  directoryPath: string,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(
      path.join(
        directoryPath,
        CODEX_PLUGIN_DIR_NAME,
        CODEX_PLUGIN_MANIFEST_FILE_NAME,
      ),
    );
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readCodexPluginManifest(
  pluginRootPath: string,
): Promise<CodexPluginManifest | null> {
  let content: string;
  try {
    content = await fs.readFile(
      path.join(
        pluginRootPath,
        CODEX_PLUGIN_DIR_NAME,
        CODEX_PLUGIN_MANIFEST_FILE_NAME,
      ),
      "utf8",
    );
  } catch {
    return null;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = codexPluginManifestSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

async function statCodexPluginCacheCandidate(
  rootPath: string,
): Promise<PluginCacheCandidate | null> {
  if (!(await directoryHasCodexPluginManifest(rootPath))) {
    return null;
  }
  try {
    const stat = await fs.stat(rootPath);
    return { rootPath, modifiedAtMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function resolveLatestPluginCacheRoot(
  pluginCacheRootPath: string,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(pluginCacheRootPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: PluginCacheCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = await statCodexPluginCacheCandidate(
      path.join(pluginCacheRootPath, entry.name),
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return (
    candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]
      ?.rootPath ?? null
  );
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function resolveEnabledCodexPlugins(
  codexHome: string,
): Promise<ExperimentalVendorPlugin[]> {
  const enabledPlugins = await readCodexEnabledPluginSettings(codexHome);
  const cacheRootPath = path.join(codexHome, "plugins", "cache");
  const plugins: ExperimentalVendorPlugin[] = [];

  for (const marketplaceEntry of await readDirectoryEntries(cacheRootPath)) {
    const marketplacePath = path.join(cacheRootPath, marketplaceEntry.name);
    for (const pluginEntry of await readDirectoryEntries(marketplacePath)) {
      const pluginId = `${pluginEntry.name}@${marketplaceEntry.name}`;
      if (enabledPlugins.get(pluginId) === false) {
        continue;
      }
      const rootPath = await resolveLatestPluginCacheRoot(
        path.join(marketplacePath, pluginEntry.name),
      );
      if (rootPath === null) {
        continue;
      }
      const manifest = await readCodexPluginManifest(rootPath);
      if (!manifest) {
        continue;
      }
      plugins.push({
        rootPath,
        name: manifest.name ?? pluginEntry.name,
        origin: "user",
        skills: manifest.skills,
      });
    }
  }
  return plugins;
}

async function resolveCodexPluginSkillRoots(
  codexHome: string,
): Promise<CodexResolvedSkillRoot[]> {
  const roots = await experimental_resolveVendorPluginRoots({
    plugins: await resolveEnabledCodexPlugins(codexHome),
    layout: "claude",
  });
  return roots.skills;
}
