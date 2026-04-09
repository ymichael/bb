import { envsafe, str } from "envsafe";
import { hostTypeSchema } from "@bb/domain";
import type { HostType } from "@bb/domain";
import { toOptionalTrimmedString } from "./strings.js";

export interface HostDaemonEntrypointConfig {
  BB_BRIDGE_DIR?: string;
  BB_CLI_DIR?: string;
  BB_HOST_ENROLL_KEY?: string;
  BB_HOST_ID?: string;
  BB_HOST_NAME?: string;
  BB_HOST_TYPE?: HostType;
}

function parseOptionalHostType(value: string): HostType | undefined {
  const normalizedValue = toOptionalTrimmedString(value);
  if (!normalizedValue) {
    return undefined;
  }

  const parsed = hostTypeSchema.safeParse(normalizedValue);
  if (!parsed.success) {
    throw new Error(`Invalid BB_HOST_TYPE "${normalizedValue}"`);
  }

  return parsed.data;
}

const rawHostDaemonEntrypointConfig = envsafe({
  BB_CLI_DIR: str({
    desc: "Directory containing the bb CLI executable to inject into runtime shells",
    default: "",
    allowEmpty: true,
  }),
  BB_BRIDGE_DIR: str({
    desc: "Directory containing provider bridge bundles for the host daemon runtime",
    default: "",
    allowEmpty: true,
  }),
  BB_HOST_ENROLL_KEY: str({
    desc: "One-time enrollment token used to bootstrap a host daemon with the bb server",
    default: "",
    allowEmpty: true,
  }),
  BB_HOST_ID: str({
    desc: "Preferred host ID to persist for the daemon instead of generating one locally",
    default: "",
    allowEmpty: true,
  }),
  BB_HOST_NAME: str({
    desc: "Preferred host name to report instead of detecting the local hostname",
    default: "",
    allowEmpty: true,
  }),
  BB_HOST_TYPE: str({
    desc: "Host type override for daemon bootstrap (persistent or ephemeral)",
    default: "",
    allowEmpty: true,
  }),
});

export const hostDaemonEntrypointConfig: HostDaemonEntrypointConfig = {
  BB_BRIDGE_DIR: toOptionalTrimmedString(rawHostDaemonEntrypointConfig.BB_BRIDGE_DIR),
  BB_CLI_DIR: toOptionalTrimmedString(rawHostDaemonEntrypointConfig.BB_CLI_DIR),
  BB_HOST_ENROLL_KEY: toOptionalTrimmedString(rawHostDaemonEntrypointConfig.BB_HOST_ENROLL_KEY),
  BB_HOST_ID: toOptionalTrimmedString(rawHostDaemonEntrypointConfig.BB_HOST_ID),
  BB_HOST_NAME: toOptionalTrimmedString(rawHostDaemonEntrypointConfig.BB_HOST_NAME),
  BB_HOST_TYPE: parseOptionalHostType(rawHostDaemonEntrypointConfig.BB_HOST_TYPE),
};
