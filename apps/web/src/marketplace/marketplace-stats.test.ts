import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_STATS_FIXTURE,
  MARKETPLACE_V2_FIXTURE,
} from "./marketplace-v2.fixture.js";
import { marketplaceEntryInstalls } from "./marketplace-model.js";
import { parseMarketplaceStats } from "./marketplace-stats.js";

describe("marketplace install stats", () => {
  it("reads install counts only from the stats sidecar", () => {
    const [counted, uncounted] = MARKETPLACE_V2_FIXTURE.plugins;
    expect(marketplaceEntryInstalls(counted!, MARKETPLACE_STATS_FIXTURE)).toBe(
      1_204,
    );
    expect(
      marketplaceEntryInstalls(uncounted!, MARKETPLACE_STATS_FIXTURE),
    ).toBeUndefined();
    expect(counted).not.toHaveProperty("installCount");
  });

  it("drops malformed plugin ids and rejects invalid counts", () => {
    expect(
      parseMarketplaceStats({
        ...MARKETPLACE_STATS_FIXTURE,
        plugins: {
          ...MARKETPLACE_STATS_FIXTURE.plugins,
          "future-plugin": { installs: 2, futureField: true },
          "Bad Plugin": { installs: 99 },
        },
      }),
    ).toMatchObject({
      plugins: {
        "prompt-library": { installs: 1_204 },
        "future-plugin": { installs: 2 },
      },
    });
    expect(() =>
      parseMarketplaceStats({
        ...MARKETPLACE_STATS_FIXTURE,
        plugins: { "prompt-library": { installs: -1 } },
      }),
    ).toThrow();
  });
});
