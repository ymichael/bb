import { describe, expect, it } from "vitest";
import { providerUsageTone, type UsageProvider } from "./usage-schema.js";

function provider(
  id: string,
  displayName: string,
  usedPercent: number,
): UsageProvider {
  return {
    id,
    displayName,
    logoUrl: null,
    iconGlyph: null,
    iconTint: null,
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        {
          label: "Five-hour limit",
          usedPercent,
          resetsAt: null,
          cost: null,
        },
      ],
    },
  };
}

describe("usage warning state", () => {
  it("distinguishes normal, warning, and critical usage", () => {
    const low = provider("codex", "Codex", 79);
    const warning = provider("codex", "Codex", 80);
    const critical = provider("codex", "Codex", 95);

    expect(providerUsageTone(low)).toBeNull();
    expect(providerUsageTone(warning)).toBe("warning");
    expect(providerUsageTone(critical)).toBe("critical");
  });
});
