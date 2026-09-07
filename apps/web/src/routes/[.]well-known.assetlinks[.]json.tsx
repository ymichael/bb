import { createFileRoute } from "@tanstack/react-router";
import { handleAppLinkAssociationRequest } from "@bb/connect-db";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/.well-known/assetlinks.json")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAppLinkAssociationRequest(request, getEnv()) ??
        new Response("not found\n", { status: 404 }),
    },
  },
});
