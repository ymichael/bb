import { isLoopbackAddress } from "@bb/config/loopback";
import { ApiError } from "../../errors.js";

export interface ResolveHostJoinServerUrlArgs {
  appUrl: string | undefined;
  isLocalJoin: boolean;
  remoteAddress: string | undefined;
  serverPort: number;
}

function createAppUrlRequiredError(): ApiError {
  return new ApiError(422, "app_url_required", "BB_APP_URL is not configured");
}

export function resolveHostJoinServerUrl(
  args: ResolveHostJoinServerUrlArgs,
): string {
  if (
    args.isLocalJoin &&
    args.remoteAddress !== undefined &&
    isLoopbackAddress(args.remoteAddress)
  ) {
    return `http://127.0.0.1:${args.serverPort}`;
  }

  if (args.appUrl === undefined) {
    throw createAppUrlRequiredError();
  }

  return args.appUrl;
}
