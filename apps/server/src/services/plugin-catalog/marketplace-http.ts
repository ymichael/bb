import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export type MarketplaceFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;
export const MARKETPLACE_PACKUMENT_MAX_BYTES = 8 * 1024 * 1024;

const deniedMarketplaceIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  deniedMarketplaceIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const deniedMarketplaceIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  deniedMarketplaceIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

export function assertPublicMarketplaceAddress(address: string): void {
  const family = isIP(address);
  if (family === 0) {
    throw new Error(`marketplace host resolved to invalid address ${address}`);
  }
  const denied =
    family === 4
      ? deniedMarketplaceIpv4Addresses.check(address, "ipv4")
      : deniedMarketplaceIpv6Addresses.check(address, "ipv6");
  if (denied) {
    throw new Error(
      `marketplace host resolved to non-public address ${address}`,
    );
  }
}

export function assertPublicMarketplaceUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("marketplace requests require an https URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("marketplace URLs cannot contain credentials");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error("marketplace requests require the standard https port 443");
  }
  const hostname = normalizedHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`marketplace host ${hostname} is not public`);
  }
  if (isIP(hostname) !== 0) assertPublicMarketplaceAddress(hostname);
  return url;
}

interface MarketplaceDnsResolver {
  (
    hostname: string,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: readonly { address: string; family: number }[],
    ) => void,
  ): void;
}

const resolveMarketplaceDns: MarketplaceDnsResolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
    callback(error, addresses),
  );

export function createPublicMarketplaceLookup(
  resolveDns: MarketplaceDnsResolver = resolveMarketplaceDns,
): LookupFunction {
  return (hostname, options, callback) => {
    resolveDns(hostname, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }
      try {
        if (addresses.length === 0) {
          throw new Error(`marketplace host ${hostname} has no addresses`);
        }
        for (const address of addresses) {
          assertPublicMarketplaceAddress(address.address);
        }
        if (options.all) {
          callback(null, [...addresses]);
          return;
        }
        const first = addresses[0];
        if (first === undefined) {
          throw new Error(`marketplace host ${hostname} has no addresses`);
        }
        callback(null, first.address, first.family);
      } catch (lookupError) {
        callback(
          lookupError instanceof Error
            ? lookupError
            : new Error(String(lookupError)),
          "",
          0,
        );
      }
    });
  };
}

const publicMarketplaceLookup = createPublicMarketplaceLookup();

export const publicMarketplaceFetch: MarketplaceFetch = async (input, init) => {
  const url = assertPublicMarketplaceUrl(input);
  if (init.body !== undefined && init.body !== null) {
    throw new Error("marketplace requests cannot contain a body");
  }
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const requestSignal = init.signal ?? undefined;
    const outgoing = request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: publicMarketplaceLookup,
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      },
      (incoming) => {
        const status = incoming.statusCode;
        if (status === undefined) {
          incoming.destroy();
          reject(new Error("marketplace response has no HTTP status"));
          return;
        }
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            responseHeaders.append(name, value);
          }
        }
        const hasNoBody = status === 204 || status === 205 || status === 304;
        resolve(
          new Response(
            hasNoBody
              ? null
              : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
};

export function marketplaceErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `request timed out after ${MARKETPLACE_FETCH_TIMEOUT_MS}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function boundedResponseJson(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const bytes = await boundedResponseBytes(response, maxBytes, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
