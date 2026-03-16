import { hc } from "hono/client";
import type { AppType } from "@bb/server/app-type";

const BASE_URL = typeof window === "undefined"
  ? "http://localhost"
  : window.location.origin;

const client = hc<AppType>(BASE_URL);

export const apiClient = client.api.v1;

export function toRelativeUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}
