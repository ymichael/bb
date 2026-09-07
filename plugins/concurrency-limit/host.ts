import { availableParallelism } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { concurrencyLimitHostContract } from "./contract.js";

interface HostCapacityDependencies {
  readonly availableParallelism: () => number;
}

export function createConcurrencyLimitHostEntry(
  dependencies: HostCapacityDependencies,
) {
  return experimental_defineHostEntry({
    contract: concurrencyLimitHostContract,
    handlers: {
      getCapacity() {
        return {
          availableParallelism: dependencies.availableParallelism(),
        };
      },
    },
  });
}

export default createConcurrencyLimitHostEntry({ availableParallelism });
