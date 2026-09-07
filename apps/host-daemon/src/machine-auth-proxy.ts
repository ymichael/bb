import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK_HOST = "127.0.0.1";
const MACHINE_HEADER = "x-bb-connect-machine";

interface StartMachineAuthProxyOptions {
  machineCredential: string;
  serverUrl: string;
  port?: number;
}

export interface MachineAuthProxy {
  serverUrl: string;
  close(): Promise<void>;
}

const BROWSER_REQUEST_HEADERS = ["origin", "sec-fetch-site"] as const;

const REJECTED_SOCKET_MESSAGES = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
} as const;

type RejectedSocketStatus = keyof typeof REJECTED_SOCKET_MESSAGES;

function isBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return BROWSER_REQUEST_HEADERS.some((name) => headers[name] !== undefined);
}

const LOOPBACK_AUTHORITY_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

function parseHostAuthority(
  host: string,
): { hostname: string; port: string } | null {
  try {
    const url = new URL(`http://${host}`);
    return url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
      ? { hostname: url.hostname, port: url.port }
      : null;
  } catch {
    return null;
  }
}

function isProxyLoopbackAuthority(
  host: string | undefined,
  boundPort: number,
): boolean {
  if (host === undefined) {
    return false;
  }
  const parsed = parseHostAuthority(host);
  if (parsed === null) {
    return false;
  }
  const hostPort = parsed.port.length > 0 ? Number(parsed.port) : 80;
  return (
    hostPort === boundPort && LOOPBACK_AUTHORITY_HOSTNAMES.has(parsed.hostname)
  );
}

function isOriginFormTarget(target: string | undefined): target is string {
  return (
    target !== undefined && target.startsWith("/") && !target.startsWith("//")
  );
}

function writeRejectedSocket(
  socket: Duplex,
  status: RejectedSocketStatus,
): void {
  socket.end(
    `HTTP/1.1 ${status} ${REJECTED_SOCKET_MESSAGES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function upstreamHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  machineCredential: string,
): IncomingHttpHeaders {
  return {
    ...headers,
    host: target.host,
    [MACHINE_HEADER]: machineCredential,
  };
}

function proxyRequest(args: {
  boundPort: number | null;
  machineCredential: string;
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
}): void {
  if (
    args.boundPort === null ||
    isBrowserRequest(args.request.headers) ||
    !isProxyLoopbackAuthority(args.request.headers.host, args.boundPort)
  ) {
    args.response.writeHead(403).end();
    return;
  }
  if (!isOriginFormTarget(args.request.url)) {
    args.response.writeHead(400).end();
    return;
  }

  const requestFn =
    args.target.protocol === "https:" ? https.request : http.request;
  const upstream = requestFn(
    {
      protocol: args.target.protocol,
      hostname: args.target.hostname,
      port: args.target.port,
      method: args.request.method,
      path: args.request.url,
      headers: upstreamHeaders(
        args.request.headers,
        args.target,
        args.machineCredential,
      ),
    },
    (upstreamResponse) => {
      args.response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(args.response);
    },
  );
  upstream.on("error", () => {
    if (!args.response.headersSent) {
      args.response.writeHead(502);
    }
    args.response.end();
  });
  args.request.pipe(upstream);
}

function proxyUpgrade(args: {
  boundPort: number | null;
  clientSocket: Duplex;
  head: Buffer;
  machineCredential: string;
  request: IncomingMessage;
  target: URL;
}): void {
  if (
    args.boundPort === null ||
    isBrowserRequest(args.request.headers) ||
    !isProxyLoopbackAuthority(args.request.headers.host, args.boundPort)
  ) {
    writeRejectedSocket(args.clientSocket, 403);
    return;
  }
  if (!isOriginFormTarget(args.request.url)) {
    writeRejectedSocket(args.clientSocket, 400);
    return;
  }

  const requestFn =
    args.target.protocol === "https:" ? https.request : http.request;
  const upstreamRequest = requestFn({
    protocol: args.target.protocol,
    hostname: args.target.hostname,
    port: args.target.port,
    method: args.request.method,
    path: args.request.url,
    headers: upstreamHeaders(
      args.request.headers,
      args.target,
      args.machineCredential,
    ),
  });
  upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
    const headerLines = response.rawHeaders
      .reduce<string[]>((lines, value, index) => {
        if (index % 2 === 0)
          lines.push(`${value}: ${response.rawHeaders[index + 1] ?? ""}\r\n`);
        return lines;
      }, [])
      .join("");
    args.clientSocket.write(`${statusLine}${headerLines}\r\n`);
    if (upstreamHead.length > 0) args.clientSocket.write(upstreamHead);
    if (args.head.length > 0) upstreamSocket.write(args.head);
    upstreamSocket.pipe(args.clientSocket).pipe(upstreamSocket);
  });
  upstreamRequest.on("response", () =>
    writeRejectedSocket(args.clientSocket, 400),
  );
  upstreamRequest.on("error", () => args.clientSocket.destroy());
  upstreamRequest.end();
}

export async function startMachineAuthProxy(
  options: StartMachineAuthProxyOptions,
): Promise<MachineAuthProxy> {
  const target = new URL(options.serverUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(
      `Unsupported machine proxy server protocol: ${target.protocol}`,
    );
  }
  const sockets = new Set<Socket>();
  let boundPort: number | null = null;
  const server = http.createServer((request, response) =>
    proxyRequest({
      boundPort,
      machineCredential: options.machineCredential,
      request,
      response,
      target,
    }),
  );
  server.on("connect", (_request, socket) => writeRejectedSocket(socket, 405));
  server.on("upgrade", (request, socket, head) =>
    proxyUpgrade({
      boundPort,
      clientSocket: socket,
      head,
      machineCredential: options.machineCredential,
      request,
      target,
    }),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  boundPort = address.port;
  return {
    serverUrl: `http://${LOOPBACK_HOST}:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
