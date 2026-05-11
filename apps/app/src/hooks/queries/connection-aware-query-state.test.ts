import { describe, expect, it } from "vitest";
import {
  getConnectionAwareQueryState,
  type ConnectionAwareQueryStateArgs,
} from "./connection-aware-query-state";

const baseArgs: ConnectionAwareQueryStateArgs = {
  hasResolvedData: false,
  isFetching: false,
  isLoadingError: false,
  serverConnectionState: "connecting",
  connectionGracePeriodElapsed: false,
};

describe("getConnectionAwareQueryState", () => {
  it("returns loading while the initial fetch is in flight", () => {
    expect(
      getConnectionAwareQueryState({ ...baseArgs, isFetching: true }).status,
    ).toBe("loading");
  });

  it("returns loading when errored within the WS grace period", () => {
    expect(
      getConnectionAwareQueryState({
        ...baseArgs,
        isLoadingError: true,
        serverConnectionState: "connecting",
        connectionGracePeriodElapsed: false,
      }).status,
    ).toBe("loading");
  });

  it("flips to unavailable once the grace period elapses without a WS connection", () => {
    expect(
      getConnectionAwareQueryState({
        ...baseArgs,
        isLoadingError: true,
        serverConnectionState: "connecting",
        connectionGracePeriodElapsed: true,
      }).status,
    ).toBe("unavailable");
  });

  it("returns unavailable when errored after the WS has connected", () => {
    expect(
      getConnectionAwareQueryState({
        ...baseArgs,
        isLoadingError: true,
        serverConnectionState: "connected",
        connectionGracePeriodElapsed: false,
      }).status,
    ).toBe("unavailable");
  });

  it("returns ready once data has resolved", () => {
    expect(
      getConnectionAwareQueryState({
        ...baseArgs,
        hasResolvedData: true,
        serverConnectionState: "connected",
      }).status,
    ).toBe("ready");
  });
});
