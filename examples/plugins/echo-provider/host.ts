import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { echoProviderHostContract } from "./contract.js";

export { experimental_providerBridge } from "./src/provider-bridge.js";

export default experimental_defineHostEntry({
  contract: echoProviderHostContract,
  handlers: {
    hostGreeting: (_input, context) => ({
      platform: process.platform,
      dataDir: context.experimental_paths.dataDir,
    }),
  },
});
