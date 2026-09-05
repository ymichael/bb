export {
  experimental_defineHostEntry,
  type ExperimentalHostEntry,
  type ExperimentalHostPaths,
  type ExperimentalHostRpcContext,
  type ExperimentalHostRpcHandlers,
  type ExperimentalHostSignalContract,
  type ExperimentalHostSignals,
  type ExperimentalHostWatchChange,
  type ExperimentalHostWatchChangeType,
  type ExperimentalHostWatchEvent,
  type ExperimentalHostWatchListener,
  type ExperimentalHostWatchOptions,
  type ExperimentalHostWatchSubscription,
  type ExperimentalHostWorkerLease,
} from "./host-contract.js";
export {
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsHostContract,
  experimental_nativeRootsResolveInputSchema,
  experimental_nativeRootsResolveOutputSchema,
  type ExperimentalDroppedNativeRoot,
  type ExperimentalFilteredNativeRoots,
  type ExperimentalNativeRootsHostContract,
  type ExperimentalNativeRootsResolveAnswer,
  type ExperimentalNativeRootsResolveInput,
  type ExperimentalNativeRootsResolveOutput,
} from "./native-roots-contract.js";
export {
  experimental_resolveClaudePluginRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalClaudePluginRoots,
  type ExperimentalClaudePluginRootsArgs,
  type ExperimentalVendorPlugin,
  type ExperimentalVendorPluginRoots,
  type ExperimentalVendorPluginRootsArgs,
} from "./vendor-plugin-roots.js";

/**
 * Kills every process whose working directory is at or under `directory`,
 * SIGTERM first and SIGKILL after the grace, for a provider tearing down a
 * workspace it made. Experimental: see docs/api_to_audit.md.
 */
export { killProcessesWithCwdUnder as experimental_killProcessesWithCwdUnder } from "@bb/process-utils";

/**
 * Spawns and stops child processes portably, for a provider plugin that runs
 * a user-supplied setup or teardown script on an enrolled machine.
 * Experimental: see docs/api_to_audit.md.
 */
export {
  killProcessGroup as experimental_killProcessGroup,
  sanitizeInheritedChildProcessEnv as experimental_sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess as experimental_spawnPortableOutputProcess,
  supportsProcessGroups as experimental_supportsProcessGroups,
} from "@bb/process-utils";
export type { SanitizeInheritedChildProcessEnvArgs as ExperimentalSanitizeInheritedChildProcessEnvArgs } from "@bb/process-utils";
