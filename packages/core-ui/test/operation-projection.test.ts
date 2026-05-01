import { describe, expect, it } from "vitest";
import { threadScope } from "@bb/domain";
import type { ViewFileEditMessage, ViewMessage } from "@bb/domain";
import {
  upsertFileEdit,
  type OperationProjectionState,
} from "../src/operation-projection.js";
import type { EventMeta } from "../src/event-decode.js";

function meta(seq: number): EventMeta {
  return {
    id: `evt-${seq}`,
    seq,
    createdAt: seq,
  };
}

function createState(): OperationProjectionState {
  return {
    messages: [],
    fileEditsByCallId: new Map<string, ViewFileEditMessage[]>(),
    fileEditStdoutBuffersByCallId: new Map(),
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    provisioningOperationsByKey: new Map(),
    permissionGrantsByInteractionId: new Map(),
    threadOperationsById: new Map(),
  };
}

function firstMessage(messages: ViewMessage[]): ViewMessage {
  const message = messages[0];
  if (!message) {
    throw new Error("Expected a projected message");
  }
  return message;
}

describe("operation projection scope", () => {
  it("does not upgrade a thread-scoped file edit into a turn-scoped file edit", () => {
    const state = createState();

    upsertFileEdit(state, meta(1), "thread-1", undefined, {
      callId: "edit-1",
      changes: [{ path: "/repo/a.ts", kind: "update" }],
      status: "pending",
    });

    expect(firstMessage(state.messages).scope).toEqual(threadScope());
    expect(() =>
      upsertFileEdit(state, meta(2), "thread-1", "turn-1", {
        callId: "edit-1",
        changes: [{ path: "/repo/a.ts", kind: "update" }],
        status: "completed",
      }),
    ).toThrow(/different scopes/);
    expect(firstMessage(state.messages).scope).toEqual(threadScope());
  });
});
