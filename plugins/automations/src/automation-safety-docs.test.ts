import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("automation execution safety documentation", () => {
  it("describes terminal target-thread failures", async () => {
    const documentation = await readFile(
      new URL(
        "../skills/automations/references/script-runtime.md",
        import.meta.url,
      ),
      "utf8",
    );
    const normalized = documentation.replace(/\s+/g, " ");

    expect(normalized).toContain("unavailable target thread");
    expect(normalized).toContain("does not retry");
    expect(normalized).toContain("does not use the failure count");
    expect(normalized).toContain(
      "disables every enabled automation that targets the thread",
    );
  });
});
