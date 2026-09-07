import { describe, expect, it } from "vitest";
import type {
  OwnershipChangeOperationAction,
  SystemThreadInterruptedReason,
  SystemThreadProvisioningStatus,
  ThreadEvent,
  ThreadEventRow,
} from "@bb/domain";
import { decodeThreadEventRow } from "../src/event-decode.js";
import {
  finalizeOperationMessage,
  interruptOperationMessage,
  parseOperationMessage,
} from "../src/parse-operation-message.js";
import type { EventProjectionOperationMessage } from "../src/event-projection-types.js";
import { createTimelineEventFactory } from "./timeline-test-harness.js";

const THREAD_ID = "thr_fixauth";
const THREAD_NAME = "Fix auth bug";

function factory() {
  return createTimelineEventFactory({ threadId: THREAD_ID });
}

function operationTitleFor(row: ThreadEventRow, threadName: string): string {
  const { event, meta } = decodeThreadEventRow(row);
  const message = parseOperationMessage(event, meta, { threadName });
  if (message === null || message.kind !== "operation") {
    throw new Error(`expected operation message, got ${message?.kind ?? null}`);
  }
  return message.title;
}

function provisioningTitle(
  status: SystemThreadProvisioningStatus,
  threadName: string,
): string {
  const row = factory().threadProvisioning({ status, entries: [] });
  return operationTitleFor(row, threadName);
}

function interruptedTitle(
  reason: SystemThreadInterruptedReason,
  threadName: string,
  cause?: "host-connection-lost",
): string {
  const row = factory().systemThreadInterrupted({ reason, cause });
  return operationTitleFor(row, threadName);
}

function ownershipTitle(
  action: OwnershipChangeOperationAction,
  parents: {
    nextParentThreadTitle: string | null;
    previousParentThreadTitle: string | null;
  },
  threadName: string,
): string {
  const row = factory().systemOperation({
    operation: "ownership_change",
    status: "completed",
    message: "",
    metadata: {
      action,
      nextParentThreadId: parents.nextParentThreadTitle ? "thr_parent" : null,
      nextParentThreadTitle: parents.nextParentThreadTitle,
      previousParentThreadId: parents.previousParentThreadTitle
        ? "thr_prev"
        : null,
      previousParentThreadTitle: parents.previousParentThreadTitle,
    },
  });
  return operationTitleFor(row, threadName);
}

describe("parseOperationMessage operation titles", () => {
  it("renders provider environment provenance without revealing masked values", () => {
    const event: ThreadEvent = {
      type: "provider.env-resolved",
      threadId: THREAD_ID,
      providerThreadId: "provider-thread-1",
      scope: { kind: "thread" },
      entries: [
        {
          name: "PLUGIN_TOKEN",
          source: { plugin: "auth-proxy" },
          value: { masked: true },
          reason: "Authenticate provider traffic",
        },
      ],
    };
    const message = parseOperationMessage(event, {
      id: "event-provider-env",
      seq: 1,
      createdAt: 1,
    });

    expect(message).toMatchObject({
      kind: "operation",
      title: "Provider environment resolved",
      detail:
        "PLUGIN_TOKEN=•••••• (auth-proxy) — Authenticate provider traffic",
    });
  });

  describe("provider-unhandled", () => {
    it("uses the projected provider display name for dynamic providers", () => {
      const row = factory().providerUnhandled({
        providerId: "acp-my-agent",
      });
      const { event, meta } = decodeThreadEventRow(row);
      const message = parseOperationMessage(event, meta, {
        includeProviderUnhandledOperations: true,
        providerDisplayName: "My Agent",
        threadName: THREAD_NAME,
      });

      expect(message).toMatchObject({
        kind: "operation",
        title: "Unhandled My Agent event",
      });
    });

    it("falls back to the provider id when no display name is projected", () => {
      const row = factory().providerUnhandled({
        providerId: "acp-my-agent",
      });
      const { event, meta } = decodeThreadEventRow(row);
      const message = parseOperationMessage(event, meta, {
        includeProviderUnhandledOperations: true,
        threadName: THREAD_NAME,
      });

      expect(message).toMatchObject({
        kind: "operation",
        title: "Unhandled acp-my-agent event",
      });
    });
  });

  describe("thread-provisioning", () => {
    it("keeps self-scoped lifecycle titles free of the current thread name", () => {
      expect(provisioningTitle("active", THREAD_NAME)).toBe(
        "Provisioning thread",
      );
      expect(provisioningTitle("completed", THREAD_NAME)).toBe(
        "Provisioned thread",
      );
      expect(provisioningTitle("failed", THREAD_NAME)).toBe(
        "Provisioning thread failed",
      );
      expect(provisioningTitle("cancelled", THREAD_NAME)).toBe(
        "Provisioning thread interrupted",
      );
    });

    it("does not depend on whether the thread is named", () => {
      expect(provisioningTitle("active", "")).toBe("Provisioning thread");
      expect(provisioningTitle("completed", "")).toBe("Provisioned thread");
    });
  });

  describe("thread-interrupted", () => {
    it("does not name or link back to the current thread", () => {
      expect(interruptedTitle("manual-stop", THREAD_NAME)).toBe(
        "Stopped manually",
      );
      expect(interruptedTitle("host-daemon-restarted", THREAD_NAME)).toBe(
        "Stopped — host daemon restarted",
      );
      expect(
        interruptedTitle(
          "host-daemon-restarted",
          THREAD_NAME,
          "host-connection-lost",
        ),
      ).toBe("Stopped — connection to host was lost");
    });
  });

  it("renders a context clear as a concise completed boundary", () => {
    const row = factory().systemOperation({
      operation: "context_clear",
      status: "completed",
      message:
        "New prompts won’t include messages above. Thread history and workspace are unchanged.",
    });
    const { event, meta } = decodeThreadEventRow(row);

    expect(
      parseOperationMessage(event, meta, { threadName: THREAD_NAME }),
    ).toMatchObject({
      kind: "operation",
      title: "Context cleared",
      detail:
        "New prompts won’t include messages above. Thread history and workspace are unchanged.",
      status: "completed",
    });
  });

  describe("ownership-change", () => {
    it("links the thread to its new/previous parent by action", () => {
      expect(
        ownershipTitle(
          "assign",
          {
            nextParentThreadTitle: "Release manager",
            previousParentThreadTitle: null,
          },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug assigned to Release manager");
      expect(
        ownershipTitle(
          "release",
          {
            nextParentThreadTitle: null,
            previousParentThreadTitle: "Release manager",
          },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug released from Release manager");
      expect(
        ownershipTitle(
          "transfer",
          {
            nextParentThreadTitle: "Frontend parent",
            previousParentThreadTitle: "Release manager",
          },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug transferred to Frontend parent");
    });

    it("falls back to 'parent' when the parent thread title is null", () => {
      expect(
        ownershipTitle(
          "assign",
          { nextParentThreadTitle: null, previousParentThreadTitle: null },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug assigned to parent");
    });
  });

  describe("post-hoc overrides stay scoped to the current thread", () => {
    function pendingProvisioning(): EventProjectionOperationMessage {
      const row = factory().threadProvisioning({
        status: "active",
        entries: [],
      });
      const { event, meta } = decodeThreadEventRow(row);
      const message = parseOperationMessage(event, meta, {
        threadName: THREAD_NAME,
      });
      if (message === null || message.kind !== "operation") {
        throw new Error("expected operation message");
      }
      return message;
    }

    it("interruptOperationMessage does not add the current thread name", () => {
      const message = pendingProvisioning();
      interruptOperationMessage(message);
      expect(message.title).toBe("Provisioning thread interrupted");
    });

    it("finalizeOperationMessage on error does not add the current thread name", () => {
      const message = pendingProvisioning();
      finalizeOperationMessage(message, {
        threadStatus: "error",
        threadName: THREAD_NAME,
      });
      expect(message.title).toBe("Provisioning thread failed");
    });
  });
});
