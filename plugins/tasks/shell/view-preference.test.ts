// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  VIEW_PREFERENCE_STORAGE_KEY,
  VIEW_PREFERENCE_VERSION,
  loadViewMode,
  storeViewMode,
} from "./view-preference.js";

const PROJECT_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PROJECT_B = "01HZZZZZZZZZZZZZZZZZZZZZP2";

beforeEach(() => window.localStorage.clear());

describe("view preference storage", () => {
  it("falls back to the list before anything is stored", () => {
    expect(loadViewMode(PROJECT_A)).toBe("list");
  });

  it("keeps other projects' choices when one project changes", () => {
    storeViewMode(PROJECT_A, "board");
    storeViewMode(PROJECT_B, "list");
    expect(loadViewMode(PROJECT_A)).toBe("board");
    expect(loadViewMode(PROJECT_B)).toBe("list");
  });

  it("treats corrupt or partial documents as unset rather than throwing", () => {
    window.localStorage.setItem(VIEW_PREFERENCE_STORAGE_KEY, "{not json");
    expect(loadViewMode(PROJECT_A)).toBe("list");

    window.localStorage.setItem(
      VIEW_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: VIEW_PREFERENCE_VERSION,
        lastUsed: "kanban",
        projects: { [PROJECT_A]: "gallery" },
      }),
    );
    expect(loadViewMode(PROJECT_A)).toBe("list");
  });

  it("leaves a document written by a newer client untouched", () => {
    const future = JSON.stringify({
      version: VIEW_PREFERENCE_VERSION + 1,
      lastUsed: "board",
      projects: { [PROJECT_A]: "board" },
      timeline: "view a future build added",
    });
    window.localStorage.setItem(VIEW_PREFERENCE_STORAGE_KEY, future);

    expect(loadViewMode(PROJECT_A)).toBe("board");
    storeViewMode(PROJECT_A, "list");
    expect(window.localStorage.getItem(VIEW_PREFERENCE_STORAGE_KEY)).toBe(
      future,
    );
  });
});
