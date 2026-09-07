export interface BuildLocalAppOriginsArgs {
  serverPort: number;
  devAppPort?: number;
  appUrl?: string;
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"] as const;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function buildLocalAppOrigins(args: BuildLocalAppOriginsArgs): string[] {
  const origins: string[] = [];
  const ports = [args.serverPort];
  if (args.devAppPort !== undefined && isValidPort(args.devAppPort)) {
    ports.push(args.devAppPort);
  }
  for (const host of LOCAL_HOSTS) {
    for (const port of ports) {
      origins.push(`http://${host}:${port}`);
    }
  }
  if (args.appUrl) {
    try {
      origins.push(new URL(args.appUrl).origin);
    } catch {}
  }
  return origins;
}
