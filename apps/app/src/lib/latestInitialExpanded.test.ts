import { describe, expect, it } from "vitest";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "./latestInitialExpanded";

describe("latestInitialExpanded", () => {
  it("auto-expands when initialExpanded transitions false -> true", () => {
    let state = createLatestInitialExpandedState(false);
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });

    expect(state.isExpanded).toBe(true);
    expect(state.isAutoExpanded).toBe(true);
    expect(state.wasUserToggled).toBe(false);
  });

  it("auto-collapses when initialExpanded transitions true -> false and row was auto-expanded", () => {
    let state = createLatestInitialExpandedState(false);
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: false,
    });

    expect(state.isExpanded).toBe(false);
    expect(state.isAutoExpanded).toBe(false);
  });

  it("preserves user collapse while initialExpanded stays true", () => {
    let state = createLatestInitialExpandedState(false);
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });
    state = reduceLatestInitialExpandedState(state, { type: "toggle" });
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });

    expect(state.isExpanded).toBe(false);
    expect(state.isAutoExpanded).toBe(false);
    expect(state.wasUserToggled).toBe(true);
  });
});
