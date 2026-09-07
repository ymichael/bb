import { createFileRoute } from "@tanstack/react-router";
import { handleSubscribe } from "@/landing/endpoints";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/api/subscribe")({
  server: {
    handlers: {
      POST: ({ request }) => handleSubscribe(request, getEnv()),
    },
  },
});
