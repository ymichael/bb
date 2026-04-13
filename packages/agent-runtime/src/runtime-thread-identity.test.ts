import type { ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  RuntimeThreadIdentityRegistry,
  stampThreadEventScope,
} from "./runtime-thread-identity.js";

describe("RuntimeThreadIdentityRegistry", () => {
  it("records provider ownership and resolves provider thread identities", async () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const providerState = registry.createProviderState({ providerId: "codex" });

    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      shouldWaitForProviderIdentity: true,
      threadId: "thread-1",
    });

    const identityPromise = registry.waitForProviderThreadIdentity({
      providerState,
      threadId: "thread-1",
      timeoutMs: 5_000,
    });
    registry.recordProviderThreadIdentity({
      providerState,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
    });

    await expect(identityPromise).resolves.toBe("provider-thread-1");
    expect(registry.resolveProviderForThread("thread-1")).toBe("codex");
    expect(registry.getProviderThreadId("thread-1")).toBe("provider-thread-1");
    expect(
      registry.resolveBbThreadIdForProviderThread({
        providerState,
        providerThreadId: "provider-thread-1",
      }),
    ).toBe("thread-1");
  });

  it("resolves provider events by source, event thread id, provider-thread mapping, and single-thread fallback", () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const providerState = registry.createProviderState({ providerId: "codex" });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      shouldWaitForProviderIdentity: false,
      threadId: "thread-1",
    });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      shouldWaitForProviderIdentity: false,
      threadId: "thread-2",
    });
    registry.recordProviderThreadIdentity({
      providerState,
      threadId: "thread-2",
      providerThreadId: "provider-thread-2",
    });

    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: "thread-1",
        eventThreadId: "provider-thread-2",
      }),
    ).toBe("thread-1");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: undefined,
        eventThreadId: "thread-2",
      }),
    ).toBe("thread-2");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: "provider-thread-2",
        eventThreadId: undefined,
      }),
    ).toBe("thread-2");
    expect(
      registry.resolveProviderEventThreadId({
        providerState,
        sourceThreadId: undefined,
        eventThreadId: "unknown-provider-thread",
      }),
    ).toBeUndefined();

    const singleThreadState = registry.createProviderState({ providerId: "claude-code" });
    registry.registerThreadProvider({
      providerId: "claude-code",
      providerState: singleThreadState,
      shouldWaitForProviderIdentity: false,
      threadId: "thread-3",
    });
    expect(
      registry.resolveProviderEventThreadId({
        providerState: singleThreadState,
        sourceThreadId: undefined,
        eventThreadId: "unknown-provider-thread",
      }),
    ).toBe("thread-3");
  });

  it("resolves pending identity waiters to null when the provider exits", async () => {
    const registry = new RuntimeThreadIdentityRegistry();
    const providerState = registry.createProviderState({ providerId: "codex" });
    registry.registerThreadProvider({
      providerId: "codex",
      providerState,
      shouldWaitForProviderIdentity: true,
      threadId: "thread-1",
    });

    const identityPromise = registry.waitForProviderThreadIdentity({
      providerState,
      threadId: "thread-1",
      timeoutMs: 5_000,
    });
    registry.resolvePendingIdentityWaiters(providerState);

    await expect(identityPromise).resolves.toBeNull();
  });

  it("stamps projected events with the resolved bb thread id", () => {
    const event: ThreadEvent = {
      type: "turn/started",
      threadId: "provider-thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    };

    expect(
      stampThreadEventScope({
        event,
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
      }),
    ).toEqual({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
  });
});
