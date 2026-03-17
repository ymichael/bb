import { describe, expect, it } from "vitest";
import {
  getPreferredManagerModel,
  getPreferredManagerProviderId,
} from "./HireManagerModal";

describe("HireManagerModal helpers", () => {
  it("prefers claude-code when available", () => {
    expect(
      getPreferredManagerProviderId(["openai", "claude-code", "pi"]),
    ).toBe("claude-code");
  });

  it("preserves the selected provider when it is still available", () => {
    expect(
      getPreferredManagerProviderId(["openai", "claude-code"], "openai"),
    ).toBe("openai");
  });

  it("prefers claude-opus-4-6 over the provider default model", () => {
    expect(
      getPreferredManagerModel([
        { model: "claude-sonnet-4", isDefault: true },
        { model: "claude-opus-4-6", isDefault: false },
      ]),
    ).toBe("claude-opus-4-6");
  });

  it("preserves the selected model when it is still available", () => {
    expect(
      getPreferredManagerModel(
        [
          { model: "claude-sonnet-4", isDefault: true },
          { model: "claude-opus-4-6", isDefault: false },
        ],
        "claude-sonnet-4",
      ),
    ).toBe("claude-sonnet-4");
  });
});
