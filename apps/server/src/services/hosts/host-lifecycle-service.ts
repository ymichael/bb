import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { createAsyncLane } from "../lib/async-lane.js";

export interface HostLifecycleService {
  dispose(): void;
  hostDestroyDeduper: ReturnType<typeof createAsyncDeduper<string, void>>;
  hostExtendDeduper: ReturnType<typeof createAsyncDeduper<string, boolean>>;
  hostLifecycleLane: ReturnType<typeof createAsyncLane<string>>;
  hostReadyDeduper: ReturnType<typeof createAsyncDeduper<string, void>>;
  hostSuspendDeduper: ReturnType<typeof createAsyncDeduper<string, boolean>>;
  nextSandboxTimeoutExtensionAt: Map<string, number>;
  pendingReadyProgressCallbacks: Map<string, Set<SandboxHostProgressCallbacks>>;
}

export function createHostLifecycleService(): HostLifecycleService {
  const hostDestroyDeduper = createAsyncDeduper<string, void>();
  const hostExtendDeduper = createAsyncDeduper<string, boolean>();
  const hostLifecycleLane = createAsyncLane<string>();
  const hostReadyDeduper = createAsyncDeduper<string, void>();
  const hostSuspendDeduper = createAsyncDeduper<string, boolean>();
  const nextSandboxTimeoutExtensionAt = new Map<string, number>();
  const pendingReadyProgressCallbacks = new Map<string, Set<SandboxHostProgressCallbacks>>();

  return {
    dispose() {
      hostDestroyDeduper.clear();
      hostExtendDeduper.clear();
      hostLifecycleLane.clear();
      hostReadyDeduper.clear();
      hostSuspendDeduper.clear();
      nextSandboxTimeoutExtensionAt.clear();
      pendingReadyProgressCallbacks.clear();
    },
    hostDestroyDeduper,
    hostExtendDeduper,
    hostLifecycleLane,
    hostReadyDeduper,
    hostSuspendDeduper,
    nextSandboxTimeoutExtensionAt,
    pendingReadyProgressCallbacks,
  };
}
