import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { createAsyncLane } from "../lib/async-lane.js";

export interface HostLifecycleService {
  hostDestroyDeduper: ReturnType<typeof createAsyncDeduper<string, void>>;
  hostExtendDeduper: ReturnType<typeof createAsyncDeduper<string, boolean>>;
  hostLifecycleLane: ReturnType<typeof createAsyncLane<string>>;
  hostReadyDeduper: ReturnType<typeof createAsyncDeduper<string, void>>;
  hostSuspendDeduper: ReturnType<typeof createAsyncDeduper<string, boolean>>;
  nextSandboxTimeoutExtensionAt: Map<string, number>;
  pendingReadyProgressCallbacks: Map<string, Set<SandboxHostProgressCallbacks>>;
}

export function createHostLifecycleService(): HostLifecycleService {
  return {
    hostDestroyDeduper: createAsyncDeduper<string, void>(),
    hostExtendDeduper: createAsyncDeduper<string, boolean>(),
    hostLifecycleLane: createAsyncLane<string>(),
    hostReadyDeduper: createAsyncDeduper<string, void>(),
    hostSuspendDeduper: createAsyncDeduper<string, boolean>(),
    nextSandboxTimeoutExtensionAt: new Map<string, number>(),
    pendingReadyProgressCallbacks: new Map<string, Set<SandboxHostProgressCallbacks>>(),
  };
}
