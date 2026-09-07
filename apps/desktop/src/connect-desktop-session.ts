import { z } from "zod";
import {
  ConnectListError,
  fetchDesktopSession,
  type ConnectCredential,
} from "@bb/connect-client";

const rpcSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    cookie: z.object({
      domain: z.string().min(1),
      expiresAt: z.number().int().positive(),
      name: z.string().min(1),
      value: z.string().min(1),
    }),
  }),
});

interface DesktopSessionCookie {
  domain: string;
  expiresAt: number;
  name: string;
  value: string;
}

interface DesktopCookie {
  domain?: string;
  name: string;
  value: string;
}

export interface DesktopCookieStore {
  get(filter: { name: string; url: string }): Promise<DesktopCookie[]>;
  set(details: {
    domain: string;
    expirationDate: number;
    httpOnly: boolean;
    name: string;
    path: string;
    sameSite: "lax";
    secure: boolean;
    url: string;
    value: string;
  }): Promise<void>;
}

type ConnectDesktopSessionFailureCode =
  | "cookie_install_failed"
  | "cookie_verification_failed"
  | "invalid_response"
  | "network"
  | "request_rejected"
  | "unauthorized";

export type ConnectDesktopSessionResult =
  | { expiresAt: number; ok: true }
  | {
      code: ConnectDesktopSessionFailureCode;
      detail: string;
      ok: false;
    };

type MintDesktopSessionCookieResult =
  | { cookie: DesktopSessionCookie; ok: true }
  | { code: ConnectDesktopSessionFailureCode; detail: string; ok: false };

type DesktopSessionCookieSource = () => Promise<MintDesktopSessionCookieResult>;

function failure(
  code: ConnectDesktopSessionFailureCode,
  detail: string,
): { code: ConnectDesktopSessionFailureCode; detail: string; ok: false } {
  return { code, detail, ok: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLocalServerCookieSource(args: {
  fetchImpl?: typeof fetch;
  localServerUrl: string;
}): DesktopSessionCookieSource {
  return async () => {
    const fetchImpl = args.fetchImpl ?? globalThis.fetch;
    const rpcUrl = new URL(
      "/api/v1/plugins/connect/rpc/createDesktopSession",
      args.localServerUrl,
    );
    let response: Response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      });
    } catch (error) {
      return failure("network", errorMessage(error));
    }
    if (!response.ok) {
      return failure("request_rejected", `HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return failure("invalid_response", errorMessage(error));
    }
    const parsed = rpcSuccessSchema.safeParse(body);
    if (!parsed.success) {
      return failure("invalid_response", "response did not match the contract");
    }
    return { cookie: parsed.data.result.cookie, ok: true };
  };
}

export function createCredentialCookieSource(args: {
  credential: ConnectCredential;
  fetchImpl?: typeof fetch;
}): DesktopSessionCookieSource {
  return async () => {
    try {
      const session = await fetchDesktopSession(
        args.credential,
        args.fetchImpl ?? globalThis.fetch,
      );
      return { cookie: session.cookie, ok: true };
    } catch (error) {
      if (error instanceof ConnectListError) {
        return failure(
          error.code === "not_paired" ? "invalid_response" : error.code,
          error.message,
        );
      }
      return failure("network", errorMessage(error));
    }
  };
}

export async function installConnectDesktopSession(args: {
  cookieStore: DesktopCookieStore;
  mintCookie: DesktopSessionCookieSource;
  remoteServerUrl: string;
}): Promise<ConnectDesktopSessionResult> {
  const minted = await args.mintCookie();
  if (!minted.ok) {
    return minted;
  }

  const { cookie } = minted;
  const remoteOrigin = new URL(args.remoteServerUrl).origin;
  try {
    await args.cookieStore.set({
      domain: cookie.domain,
      expirationDate: cookie.expiresAt / 1000,
      httpOnly: true,
      name: cookie.name,
      path: "/",
      sameSite: "lax",
      secure: remoteOrigin.startsWith("https://"),
      url: remoteOrigin,
      value: cookie.value,
    });
  } catch (error) {
    return failure("cookie_install_failed", errorMessage(error));
  }

  let installedCookies: DesktopCookie[];
  try {
    installedCookies = await args.cookieStore.get({
      name: cookie.name,
      url: remoteOrigin,
    });
  } catch (error) {
    return failure("cookie_verification_failed", errorMessage(error));
  }
  const installed = installedCookies.some(
    (candidate) =>
      candidate.name === cookie.name && candidate.value === cookie.value,
  );
  if (!installed) {
    return failure(
      "cookie_verification_failed",
      "Electron did not retain the desktop session cookie",
    );
  }
  return { expiresAt: cookie.expiresAt, ok: true };
}
