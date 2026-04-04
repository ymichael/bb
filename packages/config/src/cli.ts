import { envsafe, port, url } from "envsafe";
import { DEFAULTS } from "./defaults.js";

export const cliConfig = envsafe({
  BB_SERVER_URL: url({
    desc: "URL of the bb server",
    default: DEFAULTS.serverUrl.prod,
    devDefault: DEFAULTS.serverUrl.dev,
  }),
  BB_HOST_DAEMON_PORT: port({
    desc: "Port of the local host daemon",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
});
