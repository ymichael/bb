import {
  ConnectListError,
  ConnectMachineRedeemError,
  redeemMachineCredential,
  type ConnectCredential,
} from "@bb/connect-client";
import {
  PROFILE_LABEL_MAX_LENGTH,
  type NewServerProfile,
} from "@/lib/profiles";
import { mapAuthError } from "@/lib/session";

export interface EnrollmentFailure {
  code:
    | "invalid_code"
    | "expired"
    | "already_used"
    | "machine_limit"
    | "network"
    | "invalid_response"
    | "unauthorized"
    | "unknown";
  title: string;
  message: string;
}

export function describeEnrollmentError(error: unknown): EnrollmentFailure {
  if (error instanceof ConnectMachineRedeemError) {
    switch (error.code) {
      case "invalid_code":
        return {
          code: "invalid_code",
          title: "Code not recognized",
          message:
            "Check the pairing code and the bb connect address. Codes come from bb Settings → Remote access or `bb connect machine-code`.",
        };
      case "expired":
        return {
          code: "expired",
          title: "Code expired",
          message:
            "Pairing codes last ten minutes. Generate a new one on the server and try again.",
        };
      case "already_used":
        return {
          code: "already_used",
          title: "Code already used",
          message:
            "Each pairing code works once. Generate a new one on the server and try again.",
        };
      case "machine_limit":
        return {
          code: "machine_limit",
          title: "Device limit reached",
          message:
            "This account already has the maximum number of paired devices (20). Revoke one you no longer use in the getbb.app dashboard under Machines, then pair again.",
        };
      case "network":
        return {
          code: "network",
          title: "Could not reach bb connect",
          message: `Check your connection and try again. (${error.message})`,
        };
      case "invalid_response":
        return {
          code: "invalid_response",
          title: "Unexpected answer from bb connect",
          message: error.message,
        };
    }
  }
  if (error instanceof ConnectListError) {
    if (error.code === "unauthorized") {
      return {
        code: "unauthorized",
        title: "Device not authorized",
        message:
          "bb connect rejected this device's credential. It may have been revoked in the dashboard; pair again with a fresh code.",
      };
    }
    return {
      code: "network",
      title: "Could not reach bb connect",
      message: `Check your connection and try again. (${error.message})`,
    };
  }
  const kind = mapAuthError(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (kind === "network") {
    return {
      code: "network",
      title: "Could not reach bb connect",
      message: `Check your connection and try again. (${detail})`,
    };
  }
  return { code: "unknown", title: "Pairing failed", message: detail };
}

export interface RedeemedEnrollment {
  credential: ConnectCredential;
  profile: Extract<NewServerProfile, { mode: "connect" }>;
}

export async function redeemEnrollment(
  args: { apexUrl: string; code: string; label?: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RedeemedEnrollment> {
  const credential = await redeemMachineCredential(
    { apexUrl: args.apexUrl, code: args.code },
    fetchImpl,
  );
  const label = (args.label?.trim() || credential.handle).slice(
    0,
    PROFILE_LABEL_MAX_LENGTH,
  );
  return {
    credential,
    profile: {
      mode: "connect",
      serverUrl: credential.serverUrl,
      handle: credential.handle,
      credential: credential.credential,
      label,
    },
  };
}

export function accountServerProfile(
  credential: ConnectCredential,
  server: { handle: string; name: string; url: string },
): Extract<NewServerProfile, { mode: "connect" }> {
  return {
    mode: "connect",
    serverUrl: server.url,
    handle: server.handle,
    credential: credential.credential,
    label: (server.name.trim() || server.handle).slice(
      0,
      PROFILE_LABEL_MAX_LENGTH,
    ),
  };
}
