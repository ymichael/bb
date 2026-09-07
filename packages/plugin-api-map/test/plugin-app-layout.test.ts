import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = join(
  import.meta.dirname,
  "../../../plugins/plugin-api-docs",
);

describe("Plugin Guide app layout", () => {
  it("keeps desktop footer spacing from manufacturing page overflow", () => {
    const app = readFileSync(join(PLUGIN_ROOT, "app.tsx"), "utf8");

    expect(app).toMatch(/pb-6[^"]*lg:pb-0/);
    expect(app).toMatch(/pt-5[^"]*lg:pt-4/);
  });
});
