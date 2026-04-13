import { describe, expect, it } from "vitest";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
} from "@bb/domain";
import type { HostDaemonInteractiveRequestResponse } from "@bb/host-daemon-contract";
import {
  InteractiveRequestRegistry,
  InteractiveRequestRegistryError,
} from "./interactive-request-registry.js";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  reject: (error: Error) => void;
  resolve: (value: TValue) => void;
}

interface CreateRegistryArgs {
  registerRequest: (
    request: PendingInteractionCreate,
  ) => Promise<HostDaemonInteractiveRequestResponse>;
}

interface CreateCommandApprovalRequestArgs {
  providerRequestId?: string;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolveValue: (value: TValue) => void = () => {};
  let rejectValue: (error: Error) => void = () => {};
  const promise = new Promise<TValue>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    reject: rejectValue,
    resolve: resolveValue,
  };
}

function createCommandApprovalRequest(
  args: CreateCommandApprovalRequestArgs = {},
): PendingInteractionCreate {
  return {
    threadId: "thr_registry",
    turnId: "turn_registry",
    providerId: "codex",
    providerThreadId: "provider-thread-registry",
    providerRequestId: args.providerRequestId ?? "request-registry",
    payload: {
      kind: "command_approval",
      itemId: "item-registry",
      reason: "Needs approval",
      command: "git push",
      cwd: "/tmp/project",
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: ["accept", "decline", "cancel"],
    },
  };
}

function createCommandApprovalResolution(): PendingInteractionResolution {
  return {
    kind: "command_approval",
    decision: "accept",
  };
}

function createRegistry(args: CreateRegistryArgs): InteractiveRequestRegistry {
  return new InteractiveRequestRegistry({
    registerRequest: args.registerRequest,
  });
}

describe("InteractiveRequestRegistry", () => {
  it("registers a provider request and resolves it from an interactive.resolve command", async () => {
    const request = createCommandApprovalRequest();
    const resolution = createCommandApprovalResolution();
    const registry = createRegistry({
      registerRequest: async () => ({
        outcome: "created",
        interactionId: "pint_registry",
        status: "pending",
      }),
    });

    const pending = registry.registerAndWait(request);
    registry.resolve({
      interactionId: "pint_registry",
      providerId: request.providerId,
      providerRequestId: request.providerRequestId,
      providerThreadId: request.providerThreadId,
      resolution,
      threadId: request.threadId,
    });

    await expect(pending).resolves.toEqual(resolution);
  });

  it("deduplicates registration retries for the same live provider request", async () => {
    const request = createCommandApprovalRequest();
    const registration = createDeferred<HostDaemonInteractiveRequestResponse>();
    const registrations: PendingInteractionCreate[] = [];
    const registry = createRegistry({
      registerRequest: async (registeredRequest) => {
        registrations.push(registeredRequest);
        return registration.promise;
      },
    });

    const first = registry.registerAndWait(request);
    const second = registry.registerAndWait(request);

    expect(registrations).toEqual([request]);
    registration.resolve({
      outcome: "created",
      interactionId: "pint_registry",
      status: "pending",
    });

    const resolution = createCommandApprovalResolution();
    registry.resolve({
      interactionId: "pint_registry",
      providerId: request.providerId,
      providerRequestId: request.providerRequestId,
      providerThreadId: request.providerThreadId,
      resolution,
      threadId: request.threadId,
    });

    await expect(first).resolves.toEqual(resolution);
    await expect(second).resolves.toEqual(resolution);
  });

  it("ignores duplicate delivery after a command acknowledgement is retried", async () => {
    const request = createCommandApprovalRequest();
    const resolution = createCommandApprovalResolution();
    const registry = createRegistry({
      registerRequest: async () => ({
        outcome: "created",
        interactionId: "pint_registry",
        status: "pending",
      }),
    });

    const pending = registry.registerAndWait(request);
    const command = {
      interactionId: "pint_registry",
      providerId: request.providerId,
      providerRequestId: request.providerRequestId,
      providerThreadId: request.providerThreadId,
      resolution,
      threadId: request.threadId,
    };
    registry.resolve(command);
    registry.resolve(command);

    await expect(pending).resolves.toEqual(resolution);
  });

  it("rejects stale resolve commands that have no live provider request", () => {
    const request = createCommandApprovalRequest();
    const registry = createRegistry({
      registerRequest: async () => ({
        outcome: "created",
        interactionId: "pint_registry",
        status: "pending",
      }),
    });

    expect(() =>
      registry.resolve({
        interactionId: "pint_registry",
        providerId: request.providerId,
        providerRequestId: request.providerRequestId,
        providerThreadId: request.providerThreadId,
        resolution: createCommandApprovalResolution(),
        threadId: request.threadId,
      })
    ).toThrowError(InteractiveRequestRegistryError);
  });

  it("rejects provider waits when server registration is rejected", async () => {
    const request = createCommandApprovalRequest();
    const registry = createRegistry({
      registerRequest: async () => ({
        outcome: "rejected",
        reason: "Thread is already awaiting user interaction",
      }),
    });

    await expect(registry.registerAndWait(request)).rejects.toThrow(
      "Thread is already awaiting user interaction",
    );
  });

  it("rejects provider waits when the provider exits", async () => {
    const request = createCommandApprovalRequest();
    const registry = createRegistry({
      registerRequest: async () => ({
        outcome: "created",
        interactionId: "pint_registry",
        status: "pending",
      }),
    });

    const pending = registry.registerAndWait(request);
    registry.interruptThreads({
      providerId: request.providerId,
      reason: "Provider exited",
      threadIds: [request.threadId],
    });

    await expect(pending).rejects.toThrow("Provider exited");
  });
});
