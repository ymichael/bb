/**
 * Builds the CORS allowlist of origins the BB app frontend may be served
 * from. The same allowlist is enforced by:
 *
 *   - the BB server's API CORS middleware
 *   - the host daemon's local API CORS middleware
 *
 * so that cross-origin webpages can't drive either API from the user's
 * browser. Each consumer derives its own list from its own config rather
 * than sharing a runtime singleton, because the server and daemon run as
 * separate processes that don't necessarily agree on every value (the
 * daemon, for example, learns the server's port by parsing `BB_SERVER_URL`).
 *
 * Both `127.0.0.1` and `localhost` variants are emitted because browsers
 * treat them as distinct origins for CORS purposes.
 */
export interface BuildLocalAppOriginsArgs {
  /** Port the BB server binds on (also the prod-style frontend origin when the
   * server serves the bundle directly). */
  serverPort: number;
  /** Vite dev-server port for `apps/app`. Always included; the helper has no
   * way to know whether the runtime is in dev or prod. In prod the Vite
   * server isn't running, so allowing its port has no practical effect. */
  devAppPort: number;
  /** Public app URL when the frontend is served from a non-localhost origin
   * (e.g. a cloud-hosted deployment). Optional; an empty/invalid string is
   * silently skipped. */
  appUrl?: string;
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"] as const;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function buildLocalAppOrigins(
  args: BuildLocalAppOriginsArgs,
): string[] {
  const origins: string[] = [];
  const ports = [args.serverPort, args.devAppPort].filter(isValidPort);
  for (const host of LOCAL_HOSTS) {
    for (const port of ports) {
      origins.push(`http://${host}:${port}`);
    }
  }
  if (args.appUrl) {
    try {
      origins.push(new URL(args.appUrl).origin);
    } catch {
      // Caller's config may pass an empty / invalid value; skip silently
      // rather than refuse to start.
    }
  }
  return origins;
}
