import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

import {
  marketplaceHtmlCacheControl,
  marketplaceResponseStatus,
} from "./marketplace/marketplace-response-status.js";

const fetch = createStartHandler(async (context) => {
  const pathname = new URL(context.request.url).pathname;
  const status = marketplaceResponseStatus(
    pathname,
    context.router.state.matches.map((match) => match.loaderData),
  );
  if (status !== null) {
    context.router.stores.statusCode.set(status);
  }
  const result = await defaultStreamHandler(context);
  const response = "response" in result ? result.response : result;
  const cacheControl = marketplaceHtmlCacheControl(pathname, response.status);
  if (cacheControl === null) return result;
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl);
  const updatedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return "response" in result
    ? { ...result, response: updatedResponse }
    : updatedResponse;
});

export default { fetch };
