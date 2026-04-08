import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { CommandDispatchOptions, CommandOf } from "../command-dispatch-support.js";

export async function syncRuntimeMaterial(
  command: CommandOf<"host.sync_runtime_material">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"host.sync_runtime_material">> {
  options.runtimeManager.replaceManagedShellEnv(command.env);
  await options.runtimeManager.evictIdleEnvironments();
  await options.persistRuntimeMaterial({
    env: command.env,
    version: command.version,
  });
  return {
    appliedVersion: command.version,
  };
}
