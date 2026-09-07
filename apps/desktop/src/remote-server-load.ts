import { BUILTIN_SERVER_NAME } from "./server-target.js";

const ELECTRON_LOAD_ERROR_CODE = /\bERR_[A-Z_]+ \(-?\d+\)/u;

interface RemoteServerStartupError {
  details: string;
  logs: string;
  title: string;
}

export interface LoadRemoteServerPageArgs {
  isCurrent(): boolean;
  loadStartupError(args: RemoteServerStartupError): Promise<void>;
  loadUrl(args: { url: string }): Promise<void>;
  logWarning(message: string): void;
  serverUrl: string;
}

export function describeServerUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return "the saved bb server";
  }
  return `the bb server at ${parsed.origin}`;
}

function formatLoadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return ELECTRON_LOAD_ERROR_CODE.exec(message)?.[0] ?? "the page load failed";
}

export async function loadRemoteServerPage(
  args: LoadRemoteServerPageArgs,
): Promise<boolean> {
  try {
    await args.loadUrl({ url: args.serverUrl });
    return true;
  } catch (error) {
    if (!args.isCurrent()) {
      return false;
    }
    const label = describeServerUrl(args.serverUrl);
    args.logWarning(
      `[desktop] could not load ${label}: ${formatLoadFailure(error)}`,
    );
    await args.loadStartupError({
      details:
        `${label.charAt(0).toUpperCase()}${label.slice(1)} did not answer. ` +
        "Check that the machine is awake and reachable, then choose " +
        "Window ▸ Server to retry this server or switch to " +
        `${BUILTIN_SERVER_NAME}.`,
      logs: "",
      title: "Could not reach this bb server",
    });
    return false;
  }
}
