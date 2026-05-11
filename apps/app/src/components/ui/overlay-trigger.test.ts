import { describe, expect, it } from "vitest";
import { getOverlayTriggerClassName } from "@/components/ui/overlay-trigger";

describe("getOverlayTriggerClassName", () => {
  it("applies the select-none policy when no caller className is provided", () => {
    expect(getOverlayTriggerClassName()).toBe("select-none");
  });

  it("preserves caller classNames alongside the select-none policy", () => {
    const result = getOverlayTriggerClassName("custom-trigger");

    expect(result.split(/\s+/u)).toEqual(
      expect.arrayContaining(["select-none", "custom-trigger"]),
    );
  });
});
