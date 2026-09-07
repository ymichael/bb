import { defaultDropAnimation } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION } from "./sortableMotion";

describe("SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION", () => {
  it("cancels dnd-kit's opacity-mutating drop side effect", () => {
    expect(defaultDropAnimation.sideEffects).toBeTypeOf("function");

    const effectiveConfig = {
      ...defaultDropAnimation,
      ...SIDEBAR_DRAG_OVERLAY_DROP_ANIMATION,
    };

    expect(effectiveConfig.sideEffects).toBeNull();
  });
});
