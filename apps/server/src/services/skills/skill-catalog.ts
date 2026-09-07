import type { LoggedWorkSessionDeps } from "../../types.js";
import { getPluginSkillRootContributions } from "../plugins/plugin-agent-contributions.js";
import { generatedSkillsRootPath } from "../plugins/plugin-commands-skill.js";
import {
  resolveSkillCatalogEntries,
  type ProjectInjectedSkillSource,
  type ResolvedSkillCatalogEntry,
  type SharedInjectedSkillSource,
} from "./injected-skills.js";

interface ResolveSkillCatalogSourcesArgs {
  pluginSkillSelections?: ReadonlyMap<string, ReadonlySet<string>>;
  projectSkillSources?: readonly ProjectInjectedSkillSource[];
  sharedSkillSources?: readonly SharedInjectedSkillSource[];
}

export function resolveSkillCatalog(
  deps: Pick<LoggedWorkSessionDeps, "config" | "logger" | "skillTreeRegistry">,
  args: ResolveSkillCatalogSourcesArgs = {},
): ResolvedSkillCatalogEntry[] {
  return resolveSkillCatalogEntries(deps.logger, {
    additionalSkillsRootPaths: [
      ...deps.config.inheritedSkillsRootPaths,
      generatedSkillsRootPath(deps.config.dataDir),
    ],
    builtinSkillsRootPath: deps.config.builtinSkillsRootPath,
    dataDir: deps.config.dataDir,
    pluginSkillRoots: getPluginSkillRootContributions(),
    ...(args.pluginSkillSelections !== undefined
      ? { pluginSkillSelections: args.pluginSkillSelections }
      : {}),
    ...(args.projectSkillSources !== undefined
      ? { projectSkillSources: args.projectSkillSources }
      : {}),
    ...(args.sharedSkillSources !== undefined
      ? { sharedSkillSources: args.sharedSkillSources }
      : {}),
    skillTreeRegistry: deps.skillTreeRegistry,
  });
}
