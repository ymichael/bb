import { describe, expect, it } from "vitest";
import {
  assertThreadEventScope,
  requireThreadEventScopeTurnId,
  threadEventScopeSchema,
  threadEventTypeValues,
  threadOnlyThreadEventTypes,
  threadOrTurnThreadEventTypes,
  threadScopeRationaleByType,
  threadScope,
  turnScope,
  turnOnlyThreadEventTypes,
  validateThreadEventScope,
} from "../src/index.js";

describe("thread event scope policy", () => {
  it("classifies every normalized event type exactly once", () => {
    const classifiedTypes = [
      ...threadOnlyThreadEventTypes,
      ...turnOnlyThreadEventTypes,
      ...threadOrTurnThreadEventTypes,
    ];

    expect([...new Set(classifiedTypes)].sort()).toEqual(
      [...threadEventTypeValues].sort(),
    );
    expect(classifiedTypes).toHaveLength(threadEventTypeValues.length);
  });

  it("documents why each non-turn-only event can be thread-scoped", () => {
    for (const type of [
      ...threadOnlyThreadEventTypes,
      ...threadOrTurnThreadEventTypes,
    ]) {
      expect(threadScopeRationaleByType[type]?.length).toBeGreaterThan(0);
    }
  });

  it("rejects invalid scope at runtime", () => {
    expect(
      validateThreadEventScope({
        type: "item/completed",
        scope: threadScope(),
      }),
    ).toEqual({
      valid: false,
      message: "item/completed requires turn scope but received thread scope",
    });
  });

  it("throws when asserting invalid scope", () => {
    expect(() =>
      assertThreadEventScope({
        type: "thread/started",
        scope: turnScope("turn-1"),
      }),
    ).toThrow("thread/started requires thread scope but received turn scope");
  });

  it("allows thread-or-turn events to use either explicit scope", () => {
    expect(
      validateThreadEventScope({
        type: "provider/unhandled",
        scope: threadScope(),
      }),
    ).toEqual({ valid: true });
    expect(
      validateThreadEventScope({
        type: "provider/unhandled",
        scope: turnScope("turn-1"),
      }),
    ).toEqual({ valid: true });
  });

  it("returns the canonical turn id for turn-scoped events", () => {
    expect(
      requireThreadEventScopeTurnId({
        type: "turn/started",
        scope: turnScope("turn-1"),
      }),
    ).toBe("turn-1");
  });

  it("rejects empty turn ids at the schema boundary", () => {
    expect(threadEventScopeSchema.safeParse(turnScope("")).success).toBe(false);
  });

  it("throws when canonical turn id is requested from thread scope", () => {
    expect(() =>
      requireThreadEventScopeTurnId({
        type: "turn/started",
        scope: threadScope(),
      }),
    ).toThrow("turn/started requires turn scope but received thread scope");
  });
});
