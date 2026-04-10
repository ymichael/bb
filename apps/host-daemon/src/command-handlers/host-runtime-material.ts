import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import {
  buildHostRuntimeMaterialState,
  replaceManagedRuntimeFiles,
  resolveRuntimeMaterialEnv,
} from "@bb/host-runtime-material";
import type { CommandDispatchOptions, CommandOf } from "../command-dispatch-support.js";

export async function syncRuntimeMaterial(
  command: CommandOf<"host.sync_runtime_material">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"host.sync_runtime_material">> {
  const previousSnapshot = await options.readPersistedRuntimeMaterial();
  const snapshot = await options.fetchRuntimeMaterial(command.version);
  await replaceManagedRuntimeFiles({
    nextSnapshot: snapshot,
    previousState: previousSnapshot,
  });
  options.runtimeManager.replaceManagedShellEnv(
    resolveRuntimeMaterialEnv(snapshot.env),
  );
  await options.runtimeManager.evictIdleEnvironments();
  await options.persistRuntimeMaterial(buildHostRuntimeMaterialState(snapshot));
  return {
    appliedVersion: snapshot.version,
  };
}
