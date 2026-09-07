import { describe, expect, it } from "vitest";
import {
  createDescriptionSaver,
  type DescriptionSaveOutcome,
} from "./description-save.js";

function manualTimer() {
  let queued: (() => void) | undefined;
  return {
    schedule(run: () => void) {
      queued = run;
      return () => {
        if (queued === run) queued = undefined;
      };
    },
    fire() {
      const run = queued;
      queued = undefined;
      run?.();
    },
  };
}

function setup(
  save: (taskId: string, markdown: string) => Promise<DescriptionSaveOutcome>,
) {
  const timer = manualTimer();
  const errors: string[] = [];
  const saver = createDescriptionSaver({
    save,
    onError: (message) => errors.push(message),
    delayMs: 800,
    schedule: timer.schedule,
  });
  return { timer, errors, saver };
}

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createDescriptionSaver", () => {
  it("clears the pending draft only after the server confirms the save", async () => {
    const calls: string[] = [];
    const { timer, errors, saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    expect(saver.hasPending()).toBe(true);
    timer.fire();
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1"]);
    expect(saver.hasPending()).toBe(false);
    expect(errors).toEqual([]);
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1"]);
  });

  it("keeps the draft after a transport failure so the unmount flush retries", async () => {
    const calls: string[] = [];
    let fail = true;
    const { timer, errors, saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      if (fail) throw new Error("network down");
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    timer.fire();
    await flushMicrotasks();
    expect(errors).toEqual(["network down"]);
    expect(saver.hasPending()).toBe(true);

    fail = false;
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1", "draft v1"]);
    expect(saver.hasPending()).toBe(false);
  });

  it("does not clear a newer draft typed while a save is in flight", async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const { timer, saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    timer.fire();
    await flushMicrotasks();
    saver.onChange("task-1", "draft v2");
    release?.();
    await flushMicrotasks();
    expect(saver.hasPending()).toBe(true);
    timer.fire();
    release?.();
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1", "draft v2"]);
  });

  it("only flushes drafts belonging to the flushed task", async () => {
    const calls: Array<[string, string]> = [];
    const { saver } = setup(async (taskId, markdown) => {
      calls.push([taskId, markdown]);
      return { ok: true };
    });
    saver.onChange("task-2", "other task draft");
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual([]);
    expect(saver.hasPending()).toBe(true);
  });
});
