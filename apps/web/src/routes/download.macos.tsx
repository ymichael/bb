import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "cloudflare:workers";
import { handleDownloadMacos } from "@/landing/endpoints";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/download/macos")({
  server: {
    handlers: {
      GET: ({ request }) => handleDownloadMacos(request, getEnv(), waitUntil),
    },
  },
});
