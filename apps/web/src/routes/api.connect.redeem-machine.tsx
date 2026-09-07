import { createFileRoute } from "@tanstack/react-router";
import { depsFromEnv, redeemMachineCode } from "@/server/api";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/api/connect/redeem-machine")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          code?: string;
        };
        const result = await redeemMachineCode(
          depsFromEnv(getEnv()),
          body.code ?? "",
        );
        if ("error" in result) {
          return Response.json(
            { error: result.error },
            { status: result.status },
          );
        }
        return Response.json(result);
      },
    },
  },
});
