export function rebuiltResponse(
  body: BodyInit | null,
  source: Response,
): Response {
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
    encodeBody: "manual",
  });
}

export function relayedResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit,
): Response {
  return new Response(body, { status, headers, encodeBody: "manual" });
}
