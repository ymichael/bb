import { describe, expect, it } from "vitest";
import { createUnhandledProviderEvent } from "./provider-unhandled-event.js";

describe("provider unhandled events", () => {
  it("does not throw when raw event params are not JSON-serializable", () => {
    const event = createUnhandledProviderEvent({
      providerId: "test-provider",
      rawType: "sdk/custom",
      rawEvent: {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thread-1",
          nested: {
            unsupported: undefined,
          },
        },
      },
    });

    expect(event).toMatchObject({
      type: "provider/unhandled",
      threadId: "thread-1",
      providerId: "test-provider",
      rawType: "sdk/custom",
      rawEvent: {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          serializationError: "Provider raw event params were not JSON-serializable.",
        },
      },
    });
  });
});
