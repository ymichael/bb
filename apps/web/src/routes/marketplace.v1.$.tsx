import { createFileRoute } from "@tanstack/react-router";
import { getEnv } from "@/server/env";
import { serveMarketplaceObject } from "@/server/marketplace";

const handle = ({ request }: { request: Request }) =>
  serveMarketplaceObject({ bucket: getEnv().MARKETPLACE, request });

export const Route = createFileRoute("/marketplace/v1/$")({
  server: { handlers: { GET: handle, HEAD: handle } },
});
