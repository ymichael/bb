import { createFileRoute } from "@tanstack/react-router";
import {
  createMachineCodeForServerCredential,
  depsFromEnv,
} from "@/server/api";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/api/connect/machine-code")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const credential = request.headers.get("x-bb-connect-machine") ?? "";
        const result = await createMachineCodeForServerCredential(
          depsFromEnv(getEnv()),
          credential,
        );
        if ("status" in result) {
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
