import { describe, expect, it } from "vitest";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "../src/thread-timeline/latestInitialExpanded.js";

describe("latestInitialExpanded", () => {
  it("auto-expands when initialExpanded changes from false to true", () => {
    let state = createLatestInitialExpandedState(false);
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });

    expect(state.isExpanded).toBe(true);
    expect(state.isAutoExpanded).toBe(true);
    expect(state.wasUserToggled).toBe(false);
    expect(state.prevInitialExpanded).toBe(true);
  });

  it("collapses auto-expanded content when initialExpanded returns to false", () => {
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
    expect(state.wasUserToggled).toBe(false);
    expect(state.prevInitialExpanded).toBe(false);
  });

  it("preserves a user toggle when auto-expanded content becomes inactive", () => {
    let state = createLatestInitialExpandedState(false);
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: true,
    });
    state = reduceLatestInitialExpandedState(state, { type: "toggle" });
    state = reduceLatestInitialExpandedState(state, {
      type: "sync",
      initialExpanded: false,
    });

    expect(state.isExpanded).toBe(false);
    expect(state.isAutoExpanded).toBe(false);
    expect(state.wasUserToggled).toBe(false);
    expect(state.prevInitialExpanded).toBe(false);
  });
});
