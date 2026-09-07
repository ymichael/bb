import { randomUUID } from "node:crypto";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import { createHostEntry } from "./host.js";
import type { ResolvedRuntime } from "./runtime-pin.js";
import type { RuntimeSession } from "./runtime.js";

const runtime: ResolvedRuntime = {
  binary: process.execPath,
  version: "1.0.0-test",
  source: "release",
};
const resolver = async () => runtime;

const open = (sessionId: string) => ({
  sessionId,
  expiresAt: Date.now() + 60_000,
  idleTimeoutMs: 30_000,
});
describe("host runtime preparation", () => {
  it("long-polls one shared install, then opens with it", async () => {
    let resolveInstall!: (runtime: ResolvedRuntime) => void;
    let detail = "";
    const resolver = vi.fn(
      (args: { onProgress: (detail: string) => void }) =>
        new Promise<ResolvedRuntime>((resolve) => {
          resolveInstall = resolve;
          args.onProgress("downloading");
          detail = "downloading";
        }),
    );
    const factory = vi.fn(async (): Promise<RuntimeSession> => ({
      close: async () => {},
      stop: async () => {},
      run: async () => {
        throw new Error("unused");
      },
    }));
    const harness = experimental_createHostEntryHarness(
      createHostEntry(factory, resolver, {
        preparePollMs: 50,
        abandonedInstallGraceMs: 50,
      }),
    );
    const first = await harness.experimental_call("prepare", {});
    expect(first).toEqual({ status: "installing", detail });
    const second = harness.experimental_call("prepare", {});
    const opening = harness.experimental_call("open", open(randomUUID()));
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBeGreaterThan(
      0,
    );
    resolveInstall(runtime);
    expect(await second).toEqual({
      status: "ready",
      version: runtime.version,
      source: runtime.source,
    });
    await opening;
    expect(resolver).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ runtime }));
    await harness.experimental_dispose();
  });
  it("aborts an install nobody is waiting for and retries after failure", async () => {
    const signals: AbortSignal[] = [];
    const resolver = vi
      .fn()
      .mockImplementationOnce(
        (args: { signal: AbortSignal }) =>
          new Promise<ResolvedRuntime>((_resolve, reject) => {
            signals.push(args.signal);
            args.signal.addEventListener("abort", () =>
              reject(new Error("cancelled")),
            );
          }),
      )
      .mockRejectedValueOnce(new Error("npm is not available"))
      .mockResolvedValueOnce(runtime);
    const harness = experimental_createHostEntryHarness(
      createHostEntry(vi.fn(), resolver, {
        preparePollMs: 5_000,
        abandonedInstallGraceMs: 30,
      }),
    );
    const controller = new AbortController();
    const poll = harness.experimental_call(
      "prepare",
      {},
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    await expect(poll).rejects.toThrow();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0),
    );
    await expect(harness.experimental_call("prepare", {})).rejects.toThrow(
      "npm is not available",
    );
    expect(await harness.experimental_call("prepare", {})).toMatchObject({
      status: "ready",
    });
    expect(resolver).toHaveBeenCalledTimes(3);
    await harness.experimental_dispose();
  });
});
describe("host long-poll abandonment", () => {
  it("releases the poll waiter when prepare returns installing, so an unpolled install is aborted", async () => {
    const signals: AbortSignal[] = [];
    const resolver = vi.fn(
      (args: { signal: AbortSignal }) =>
        new Promise<ResolvedRuntime>((_resolve, reject) => {
          signals.push(args.signal);
          args.signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          );
        }),
    );
    const harness = experimental_createHostEntryHarness(
      createHostEntry(vi.fn(), resolver, {
        preparePollMs: 20,
        abandonedInstallGraceMs: 40,
      }),
    );
    expect(await harness.experimental_call("prepare", {})).toMatchObject({
      status: "installing",
    });
    expect(signals[0]!.aborted).toBe(false);
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0),
    );
    await harness.experimental_dispose();
  });
});
describe("host session lifetime", () => {
  it("stop disposes only the selected runtime and reload disposes the rest", async () => {
    const firstClose = vi.fn(async () => {});
    const secondClose = vi.fn(async () => {});
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ close: firstClose })
      .mockResolvedValueOnce({ close: secondClose });
    const harness = experimental_createHostEntryHarness(
      createHostEntry(factory, resolver),
    );
    const a = randomUUID(),
      b = randomUUID();
    await harness.experimental_call("open", open(a));
    await harness.experimental_call("open", open(b));
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(2);
    await harness.experimental_call("stop", { sessionId: a });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await harness.experimental_dispose();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });
  it("cancellation closes a running session and rejects further use", async () => {
    const close = vi.fn(async () => {});
    const harness = experimental_createHostEntryHarness(
      createHostEntry(
        async () => ({
          close,
          stop: close,
          run: async (_script, _timeout, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("cancelled")),
                { once: true },
              );
            }),
        }),
        resolver,
      ),
    );
    const id = randomUUID();
    await harness.experimental_call("open", open(id));
    const controller = new AbortController();
    const run = harness.experimental_call(
      "run",
      { sessionId: id, script: "1", timeoutMs: 1000 },
      { signal: controller.signal },
    );
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() =>
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    await expect(
      harness.experimental_call("run", {
        sessionId: id,
        script: "1",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("stopped");
    await harness.experimental_dispose();
  });
  it("failed startup releases worker retention", async () => {
    const harness = experimental_createHostEntryHarness(
      createHostEntry(async () => {
        throw new Error("launch failed");
      }, resolver),
    );
    await expect(
      harness.experimental_call("open", open(randomUUID())),
    ).rejects.toThrow("launch failed");
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await harness.experimental_dispose();
  });
});
