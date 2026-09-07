import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { sleep } from "./sweep.js";

it("does not retain abort listeners from completed sweep waits", async () => {
  const controller = new AbortController();
  for (let index = 0; index < 12; index += 1) {
    await sleep(0, controller.signal);
  }
  const listenerCount = getEventListeners(controller.signal, "abort").length;

  controller.abort();

  expect(listenerCount).toBe(0);
});
