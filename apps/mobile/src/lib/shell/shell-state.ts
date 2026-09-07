import type { SessionState } from "../session/session-scheduler";

export type ShellLoadPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; detail: string }
  | { kind: "http-error"; status: number };

export type ShellScreenState =
  | { kind: "loading"; message: string }
  | { kind: "no-profile" }
  | { kind: "webview" }
  | {
      kind: "error";
      title: string;
      detail: string;
      action: "retry" | "re-pair";
    };

interface ShellScreenInput {
  storeReady: boolean;
  hasAnyProfile: boolean;
  hasProfile: boolean;
  session: SessionState;
  load: ShellLoadPhase;
}

export function resolveShellScreenState(
  input: ShellScreenInput,
): ShellScreenState {
  if (!input.storeReady) {
    return { kind: "loading", message: "Opening server" };
  }
  if (!input.hasAnyProfile) {
    return { kind: "no-profile" };
  }
  if (!input.hasProfile) {
    return { kind: "loading", message: "Opening server" };
  }
  switch (input.session.status) {
    case "auth-required":
      return {
        kind: "error",
        title: "This server needs pairing again",
        detail: input.session.detail,
        action: "re-pair",
      };
    case "error":
      return {
        kind: "error",
        title: "Cannot reach this server",
        detail: input.session.detail,
        action: "retry",
      };
    case "authenticating":
      return { kind: "loading", message: "Signing in" };
    case "idle":
    case "authenticated":
      break;
  }
  switch (input.load.kind) {
    case "failed":
      return {
        kind: "error",
        title: "The page did not load",
        detail: input.load.detail,
        action: "retry",
      };
    case "http-error":
      return {
        kind: "error",
        title: "The server answered with an error",
        detail: `HTTP ${input.load.status}`,
        action: "retry",
      };
    case "loading":
      return { kind: "webview" };
    case "ready":
      return { kind: "webview" };
  }
}

export function shouldReloadForSession(
  previous: SessionState,
  next: SessionState,
): boolean {
  if (next.status !== "authenticated") return false;
  if (previous.status !== "authenticated") return true;
  return previous.expiresAt !== next.expiresAt;
}
