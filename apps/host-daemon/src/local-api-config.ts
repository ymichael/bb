import type { HostType } from "@bb/domain";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import {
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST,
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE,
  DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
  DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE,
} from "@bb/host-daemon-contract";

export type HostDaemonLocalApiMode = "full" | "health-only";

export interface HostDaemonLocalApiConfig {
  bindHost: string;
  healthPath: string;
  healthValue: string;
  mode: HostDaemonLocalApiMode;
  port: number;
}

export interface HostDaemonLocalApiOverrides {
  bindHost?: string;
  healthPath?: string;
  healthValue?: string;
  mode?: HostDaemonLocalApiMode;
  port?: number;
}

export interface ResolveHostDaemonLocalApiConfigArgs {
  hostType: HostType;
  localApi: HostDaemonLocalApiOverrides | undefined;
}

function getHostDaemonLocalApiDefaults(
  hostType: HostType,
): HostDaemonLocalApiConfig {
  if (hostType === "ephemeral") {
    return {
      bindHost: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_BIND_HOST,
      healthPath: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
      healthValue: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_HEALTH_VALUE,
      mode: "health-only",
      port: DEFAULT_EPHEMERAL_HOST_DAEMON_LOCAL_PORT,
    };
  }

  return {
    bindHost: DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
    healthPath: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
    healthValue: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_VALUE,
    mode: "full",
    port: hostDaemonConfig.BB_HOST_DAEMON_PORT,
  };
}

export function resolveHostDaemonLocalApiConfig(
  args: ResolveHostDaemonLocalApiConfigArgs,
): HostDaemonLocalApiConfig {
  const defaults = getHostDaemonLocalApiDefaults(args.hostType);
  return {
    bindHost: args.localApi?.bindHost ?? defaults.bindHost,
    healthPath: args.localApi?.healthPath ?? defaults.healthPath,
    healthValue: args.localApi?.healthValue ?? defaults.healthValue,
    mode: args.localApi?.mode ?? defaults.mode,
    port: args.localApi?.port ?? defaults.port,
  };
}
