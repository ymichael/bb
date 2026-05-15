import { describe, expect, it } from "vitest";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import {
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST,
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE,
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE,
} from "@bb/host-daemon-contract";
import { resolveHostDaemonLocalApiConfig } from "./local-api-config.js";

describe("host daemon local API config", () => {
  it("uses persistent defaults for persistent hosts", () => {
    expect(
      resolveHostDaemonLocalApiConfig({
        hostType: "persistent",
        localApi: undefined,
      }),
    ).toEqual({
      bindHost: DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
      healthPath: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
      healthValue: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE,
      mode: "full",
      port: hostDaemonConfig.BB_HOST_DAEMON_PORT,
    });
  });

  it("uses health-only sandbox defaults for ephemeral hosts", () => {
    expect(
      resolveHostDaemonLocalApiConfig({
        hostType: "ephemeral",
        localApi: undefined,
      }),
    ).toEqual({
      bindHost: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST,
      healthPath: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
      healthValue: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE,
      mode: "health-only",
      port: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT,
    });
  });

  it("allows explicit overrides on top of the host-type preset", () => {
    expect(
      resolveHostDaemonLocalApiConfig({
        hostType: "ephemeral",
        localApi: {
          healthPath: "/ready",
          healthValue: "healthy",
          port: 9123,
        },
      }),
    ).toEqual({
      bindHost: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST,
      healthPath: "/ready",
      healthValue: "healthy",
      mode: "health-only",
      port: 9123,
    });
  });
});
