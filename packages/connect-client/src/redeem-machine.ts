import { z } from "zod";
import type { ConnectCredential } from "./credential.js";

const redeemMachineResponseSchema = z.object({
  credential: z.string().min(1),
  machineId: z.string().min(1),
  serverUrl: z.string().nullable(),
});

const redeemMachineErrorSchema = z.object({ error: z.string() });

type ConnectMachineRedeemErrorCode =
  | "already_used"
  | "expired"
  | "invalid_code"
  | "machine_limit"
  | "network"
  | "invalid_response";

export class ConnectMachineRedeemError extends Error {
  constructor(
    readonly code: ConnectMachineRedeemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectMachineRedeemError";
  }
}

function codeForStatus(
  status: number,
  wireError: string,
): ConnectMachineRedeemErrorCode {
  if (wireError === "machine-limit") return "machine_limit";
  if (wireError === "already-used" || status === 409) return "already_used";
  if (wireError === "expired" || status === 410) return "expired";
  if (status >= 500) return "network";
  return "invalid_code";
}

function handleForApex(serverUrl: string, apexUrl: string): string | null {
  let parsed: URL;
  let apex: URL;
  try {
    parsed = new URL(serverUrl);
    apex = new URL(apexUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== apex.protocol || parsed.port !== apex.port) {
    return null;
  }
  const [label, ...rest] = parsed.hostname.split(".");
  if (label === undefined || label.length === 0) {
    return null;
  }
  return rest.join(".") === apex.hostname ? label : null;
}

export async function redeemMachineCredential(
  args: { apexUrl: string; code: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ConnectCredential> {
  const url = `${args.apexUrl.replace(/\/$/u, "")}/api/connect/redeem-machine`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args.code }),
    });
  } catch (error) {
    throw new ConnectMachineRedeemError(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConnectMachineRedeemError(
      "invalid_response",
      "Machine redeem returned non-JSON",
    );
  }

  if (!response.ok) {
    const parsedError = redeemMachineErrorSchema.safeParse(body);
    const wireError = parsedError.success ? parsedError.data.error : "";
    throw new ConnectMachineRedeemError(
      codeForStatus(response.status, wireError),
      `Machine redeem failed (${response.status})${wireError ? `: ${wireError}` : ""}`,
    );
  }

  const parsed = redeemMachineResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ConnectMachineRedeemError(
      "invalid_response",
      "Machine redeem response failed schema validation",
    );
  }
  const { credential, serverUrl } = parsed.data;
  if (serverUrl === null) {
    throw new ConnectMachineRedeemError(
      "invalid_response",
      "Machine redeem returned no server URL",
    );
  }
  const handle = handleForApex(serverUrl, args.apexUrl);
  if (handle === null) {
    throw new ConnectMachineRedeemError(
      "invalid_response",
      `Machine redeem returned a server URL outside ${args.apexUrl}`,
    );
  }
  return { credential, handle, serverUrl };
}
