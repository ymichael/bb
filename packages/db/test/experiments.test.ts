import { describe, expect, it } from "vitest";
import { defaultExperiments } from "@bb/domain";
import {
  createConnection,
  getExperiments,
  migrate,
  setExperiments,
} from "../src/index.js";

describe("experiments", () => {
  it("stores typed experiment keys and ignores unknown stored keys", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      expect(getExperiments(db)).toEqual(defaultExperiments);

      const experiments = {
        ...defaultExperiments,
        mobileApp: true,
      };
      setExperiments(db, experiments);
      db.$client
        .prepare(
          "INSERT INTO system_experiments (key, value, updated_at) VALUES ('futureExperiment', true, 1)",
        )
        .run();

      expect(getExperiments(db)).toEqual(experiments);
      expect(
        db.$client
          .prepare<[], { key: string }>(
            "SELECT key FROM system_experiments ORDER BY key",
          )
          .all()
          .map((row) => row.key),
      ).toEqual([
        "changelogPreview",
        "editMessages",
        "futureExperiment",
        "mobileApp",
        "sidebarProgressiveDisclosure",
        "timelineWindowing",
      ]);
    } finally {
      db.$client.close();
    }
  });
});
