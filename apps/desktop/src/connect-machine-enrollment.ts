import { z } from "zod";
import {
  ConnectMachineRedeemError,
  deriveConnectBaseUrl,
  redeemMachineCredential,
  type ConnectCredential,
} from "@bb/connect-client";

const CREATE_MACHINE_CODE_RPC = "createMachineCode";

const machineCodeRpcSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        code: z.string().min(1),
        expiresAt: z.number(),
        serverUrl: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const rpcFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

type EnrollDesktopMachineFailureCode =
  | "machine_limit"
  | "not_paired"
  | "network"
  | "invalid_response";

type EnrollDesktopMachineResult =
  | { ok: true; credential: ConnectCredential }
  | { code: EnrollDesktopMachineFailureCode; detail: string; ok: false };

interface EnrollDesktopMachineArgs {
  fetchImpl?: typeof fetch;
  localServerUrl: string;
}

function failure(
  code: EnrollDesktopMachineFailureCode,
  detail: string,
): EnrollDesktopMachineResult {
  return { code, detail, ok: false };
}

function redeemFailureCode(
  error: ConnectMachineRedeemError,
): EnrollDesktopMachineFailureCode {
  if (error.code === "machine_limit") return "machine_limit";
  if (error.code === "network") return "network";
  return "invalid_response";
}

export async function enrollDesktopMachine(
  args: EnrollDesktopMachineArgs,
): Promise<EnrollDesktopMachineResult> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const base = args.localServerUrl.replace(/\/$/u, "");
  const rpcUrl = `${base}/api/v1/plugins/connect/rpc/${CREATE_MACHINE_CODE_RPC}`;

  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
  } catch (error) {
    return failure(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("invalid_response", "machine code response was not JSON");
  }

  const minted = machineCodeRpcSchema.safeParse(body);
  if (!minted.success) {
    const rejected = rpcFailureSchema.safeParse(body);
    const wireError = rejected.success ? rejected.data.error.message : "";
    if (wireError === "not_paired") {
      return failure("not_paired", "this bb is not paired with bb Connect");
    }
    if (wireError === "machine_limit") {
      return failure("machine_limit", "the account is at its machine limit");
    }
    return failure(
      "invalid_response",
      wireError.length > 0
        ? wireError
        : "machine code response did not match the contract",
    );
  }

  try {
    const credential = await redeemMachineCredential(
      {
        apexUrl: deriveConnectBaseUrl(minted.data.result.serverUrl),
        code: minted.data.result.code,
      },
      fetchImpl,
    );
    return { credential, ok: true };
  } catch (error) {
    if (error instanceof ConnectMachineRedeemError) {
      return failure(redeemFailureCode(error), error.message);
    }
    return failure(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }
}
