// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../shared/contract.js";
import {
  isBareKey,
  PRIORITY_MENU_ORDER,
  priorityForShortcut,
  statusForShortcut,
} from "./property-menus.js";

describe("PRIORITY_MENU_ORDER", () => {
  it("lists No priority first (0) and covers every priority once", () => {
    expect(PRIORITY_MENU_ORDER[0]).toBe("none");
    expect([...PRIORITY_MENU_ORDER].sort()).toEqual(
      [...TASK_PRIORITIES].sort(),
    );
  });
});

describe("statusForShortcut", () => {
  it("maps 1-based digits to canonical status order", () => {
    expect(statusForShortcut("1")).toBe(TASK_STATUSES[0]);
    expect(statusForShortcut("3")).toBe(TASK_STATUSES[2]);
    expect(statusForShortcut("6")).toBe(TASK_STATUSES[5]);
  });

  it("rejects out-of-range and non-digit keys", () => {
    expect(statusForShortcut("0")).toBeNull();
    expect(statusForShortcut("7")).toBeNull();
    expect(statusForShortcut("s")).toBeNull();
    expect(statusForShortcut("")).toBeNull();
  });
});

describe("priorityForShortcut", () => {
  it("maps 0-based digits to the picker order", () => {
    expect(priorityForShortcut("0")).toBe("none");
    expect(priorityForShortcut("1")).toBe("urgent");
    expect(priorityForShortcut("4")).toBe("low");
  });

  it("rejects out-of-range and non-digit keys", () => {
    expect(priorityForShortcut("5")).toBeNull();
    expect(priorityForShortcut("p")).toBeNull();
  });
});

describe("isBareKey", () => {
  const base = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  it("is true only with no modifier held", () => {
    expect(isBareKey(base)).toBe(true);
    expect(isBareKey({ ...base, metaKey: true })).toBe(false);
    expect(isBareKey({ ...base, ctrlKey: true })).toBe(false);
    expect(isBareKey({ ...base, altKey: true })).toBe(false);
    expect(isBareKey({ ...base, shiftKey: true })).toBe(false);
  });
});
