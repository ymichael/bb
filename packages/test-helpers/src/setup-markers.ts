import fs from "node:fs/promises";

export interface WaitForSetupMarkerCountArgs {
  expectedCount: number;
  markerDir: string;
  timeoutMs: number;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function listSetupMarkers(markerDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(markerDir)).filter((entry) =>
      entry.startsWith("started-"),
    );
  } catch {
    return [];
  }
}

export async function waitForSetupMarkerCount(
  args: WaitForSetupMarkerCountArgs,
): Promise<string[]> {
  const startedAt = Date.now();
  let markers: string[] = [];
  while (Date.now() - startedAt <= args.timeoutMs) {
    markers = await listSetupMarkers(args.markerDir);
    if (markers.length >= args.expectedCount) {
      return markers;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${args.expectedCount} setup markers; saw ${markers.length}`,
  );
}
