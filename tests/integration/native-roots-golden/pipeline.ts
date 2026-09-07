import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
  normalizeProviderNativeRoots,
  providerNativeRootSetSchema,
  type ProviderNativeRootSet,
} from "@bb/domain";
import type {
  DiscoveredSkill,
  HostProviderCommand,
} from "@bb/host-daemon-contract";
import type { PluginProviderDeclaration } from "../../../packages/plugin-sdk/src/backend-contract.js";
import {
  discoverProviderCommands,
  discoverSkills,
} from "../../../apps/host-daemon/src/command-discovery.js";
import { resolveDeclaredScanRoots } from "../../../apps/host-daemon/src/command-handlers/list-commands.js";
import { resolveSkillScanRoots } from "../../../apps/host-daemon/src/command-handlers/list-skills.js";
import {
  experimental_nativeRootsResolveOutputSchema,
  type ExperimentalNativeRootsResolveAnswer,
} from "../../../packages/plugin-sdk/src/native-roots-contract.js";
import {
  KNOWN_ACP_AGENTS,
  acpProviderDeclaration,
  resolveAcpNativeRoots,
} from "../../../plugins/provider-acp/src/native-roots/index.js";
import {
  CLAUDE_NATIVE_ROOTS_DECLARATION,
  resolveClaudeNativeRoots,
} from "../../../plugins/provider-claude-code/src/native-roots.js";
import {
  CODEX_NATIVE_ROOTS_DECLARATION,
  resolveCodexNativeRoots,
} from "../../../plugins/provider-codex/src/native-roots.js";
import {
  PI_NATIVE_ROOTS_DECLARATION,
  resolvePiNativeRoots,
} from "../../../plugins/provider-pi/src/native-roots.js";

export interface PipelineInput {
  providerId: string;
  cwd: string | null;
  homeDir: string;
}

export interface PipelineOutput {
  commands: HostProviderCommand[];
  skills: DiscoveredSkill[];
}

export type Pipeline = (input: PipelineInput) => Promise<PipelineOutput>;

type NativeRootDeclaration = Pick<
  PluginProviderDeclaration,
  | "experimental_nativeSkillRoots"
  | "experimental_nativeCommandRoots"
  | "experimental_resolvesNativeRoots"
>;

interface ProviderNativeRootSource {
  declaration: NativeRootDeclaration;
  resolve: (
    cwd: string | null,
    homeDir: string,
  ) => Promise<ExperimentalNativeRootsResolveAnswer>;
}

function providerSource(providerId: string): ProviderNativeRootSource {
  const env = process.env;
  if (providerId === "claude-code") {
    return {
      declaration: CLAUDE_NATIVE_ROOTS_DECLARATION,
      resolve: (cwd, homeDir) =>
        resolveClaudeNativeRoots({ cwd, homeDir, env }),
    };
  }
  if (providerId === "codex") {
    return {
      declaration: CODEX_NATIVE_ROOTS_DECLARATION,
      resolve: (_cwd, homeDir) => resolveCodexNativeRoots({ homeDir, env }),
    };
  }
  if (providerId === "pi") {
    return {
      declaration: PI_NATIVE_ROOTS_DECLARATION,
      resolve: (_cwd, homeDir) => resolvePiNativeRoots({ homeDir, env }),
    };
  }
  const agent = KNOWN_ACP_AGENTS.find(
    (candidate) => candidate.id === providerId,
  );
  if (agent === undefined) {
    throw new Error(`no native-root source for provider "${providerId}"`);
  }
  return {
    declaration: acpProviderDeclaration(agent),
    resolve: (cwd, homeDir) =>
      resolveAcpNativeRoots({ agentId: providerId, cwd, homeDir, env }),
  };
}

async function nativeRootSet(
  input: PipelineInput,
): Promise<ProviderNativeRootSet> {
  const source = providerSource(input.providerId);
  const { declaration } = source;
  const resolved =
    declaration.experimental_resolvesNativeRoots === true
      ? experimental_nativeRootsResolveOutputSchema.parse(
          await source.resolve(input.cwd, input.homeDir),
        )
      : EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS;
  return providerNativeRootSetSchema.parse({
    skills:
      declaration.experimental_nativeSkillRoots === undefined
        ? EMPTY_PROVIDER_NATIVE_ROOTS
        : normalizeProviderNativeRoots(
            declaration.experimental_nativeSkillRoots,
          ),
    commands:
      declaration.experimental_nativeCommandRoots === undefined
        ? EMPTY_PROVIDER_NATIVE_ROOTS
        : normalizeProviderNativeRoots(
            declaration.experimental_nativeCommandRoots,
          ),
    resolved,
  });
}

export const pipeline: Pipeline = async (input) => {
  const resolution = {
    providerId: input.providerId,
    cwd: input.cwd,
    homeDir: input.homeDir,
    nativeRoots: await nativeRootSet(input),
  };
  const commands = await discoverProviderCommands({
    roots: await resolveDeclaredScanRoots(resolution),
  });
  const skills = await discoverSkills({
    roots: await resolveSkillScanRoots(resolution),
  });
  return { commands, skills };
};
