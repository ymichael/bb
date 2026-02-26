import { describe, expect, it } from "vitest";
import {
  createEnvironmentAdapter,
  listAvailableEnvironmentInfos,
} from "../environment-registry.js";

describe("environment registry", () => {
  it("creates local environment by default", () => {
    const environment = createEnvironmentAdapter({ environmentId: "local" });
    expect(environment.info.id).toBe("local");
  });

  it("creates worktree environment", () => {
    const environment = createEnvironmentAdapter({ environmentId: "worktree" });
    expect(environment.info.id).toBe("worktree");
    expect(environment.info.capabilities.isolatedFilesystem).toBe(true);
  });

  it("lists environment catalog", () => {
    const ids = listAvailableEnvironmentInfos().map((environment) => environment.id);
    expect(ids).toEqual(["local", "worktree"]);
  });
});
