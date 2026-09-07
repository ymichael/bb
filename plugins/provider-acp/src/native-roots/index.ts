import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { KNOWN_ACP_AGENTS } from "../known-agents.js";
import type { AcpNativeRootsResolverArgs } from "./resolver.js";

export { acpProviderDeclaration } from "../declaration.js";
export { KNOWN_ACP_AGENTS } from "../known-agents.js";
export type { AcpNativeRootsResolverArgs } from "./resolver.js";

export async function resolveAcpNativeRoots(
  args: AcpNativeRootsResolverArgs & { agentId: string },
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const resolver = KNOWN_ACP_AGENTS.find(
    (agent) => agent.id === args.agentId,
  )?.nativeRootsResolver;
  if (resolver === undefined) {
    return {};
  }
  const answer = await resolver({
    cwd: args.cwd,
    homeDir: args.homeDir,
    env: args.env,
  });
  return experimental_filterResolvedNativeRoots(answer, { warn: console.warn })
    .answer;
}
