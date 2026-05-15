import {
  createAsyncDeduper,
  type AsyncDeduper,
} from "./services/lib/async-deduper.js";

export interface LifecycleDedupers {
  environmentCleanupAdvance: AsyncDeduper<string, void>;
  queuedMessageAutoSend: AsyncDeduper<string, void>;
  sandboxBootstrap: AsyncDeduper<string, void>;
  threadProvisionAdvance: AsyncDeduper<string, void>;
}

export function createLifecycleDedupers(): LifecycleDedupers {
  return {
    environmentCleanupAdvance: createAsyncDeduper<string, void>(),
    queuedMessageAutoSend: createAsyncDeduper<string, void>(),
    sandboxBootstrap: createAsyncDeduper<string, void>(),
    threadProvisionAdvance: createAsyncDeduper<string, void>(),
  };
}
