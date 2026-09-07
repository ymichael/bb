import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import {
  withThreadContextClearGuard,
  withThreadSendGuard,
} from "../../../src/services/threads/thread-context-mutation-guard.js";

describe("thread context mutation guard", () => {
  it("rejects sends while a context clear owns the thread", async () => {
    const started = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    const clear = withThreadContextClearGuard("thread-clear", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    await expect(
      withThreadSendGuard("thread-clear", async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    release.resolve();
    await clear;
    await expect(
      withThreadSendGuard("thread-clear", async () => "sent"),
    ).resolves.toBe("sent");
  });

  it("allows overlapping sends but excludes clear until both settle", async () => {
    const release = createDeferredPromise<void>();
    const send = () =>
      withThreadSendGuard("thread-send", async () => {
        await release.promise;
      });
    const sends = [send(), send()];

    await expect(
      withThreadContextClearGuard("thread-send", async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    release.resolve();
    await Promise.all(sends);
    await expect(
      withThreadContextClearGuard("thread-send", async () => "cleared"),
    ).resolves.toBe("cleared");
  });
});
