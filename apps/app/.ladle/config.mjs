import { networkInterfaces } from "node:os";

function formatNetworkUrls(serverUrl) {
  const parsedUrl = new URL(serverUrl);
  const path = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  const interfaces = networkInterfaces();
  const addresses = [];
  const seenAddresses = new Set();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        seenAddresses.has(entry.address)
      ) {
        continue;
      }

      seenAddresses.add(entry.address);
      addresses.push({ address: entry.address, name });
    }
  }

  addresses.sort((left, right) => {
    const leftIsTailscale = left.name.startsWith("tailscale") ? 0 : 1;
    const rightIsTailscale = right.name.startsWith("tailscale") ? 0 : 1;
    return leftIsTailscale - rightIsTailscale;
  });

  return [
    `[storybook] Local:   ${parsedUrl.protocol}//localhost:${parsedUrl.port}${path}`,
    ...addresses.map(
      (entry) =>
        `[storybook] Network: ${parsedUrl.protocol}//${entry.address}:${parsedUrl.port}${path} (${entry.name})`,
    ),
  ];
}

/** @type {import("@ladle/react").UserConfig} */
export default {
  stories: ["src/**/*.stories.tsx", "../../plugins/workflows/**/*.stories.tsx"],
  defaultStory: "",
  viteConfig: "./.ladle/vite.config.ts",
  host: "0.0.0.0",
  // Ladle defaults Vite HMR to localhost independently of `host`.
  // Empty string keeps Vite's websocket listener non-loopback and lets
  // the browser use the page hostname for the websocket URL.
  hmrHost: "",
  addons: {
    theme: {
      defaultState: "dark",
    },
  },
  onDevServerStart(serverUrl) {
    if (new URL(serverUrl).hostname !== "0.0.0.0") {
      return;
    }

    process.stdout.write(`${formatNetworkUrls(serverUrl).join("\n")}\n`);
  },
};
