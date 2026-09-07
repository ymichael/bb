import { createFileRoute } from "@tanstack/react-router";
import { depsFromEnv, redeemConnectCode } from "@/server/api";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/api/connect/redeem")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          code?: string;
        };
        const result = await redeemConnectCode(
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
