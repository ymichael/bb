import { bool, envsafe, port, url } from "envsafe";
import { commonConfig } from "./common.js";
import { DEFAULTS } from "./defaults.js";

export { commonConfig };

const rawHostDaemonConfig = envsafe({
  BB_SERVER_URL: url({
    desc: "URL of the bb server this daemon connects to",
    default: DEFAULTS.serverUrl.prod,
    devDefault: DEFAULTS.serverUrl.dev,
  }),
  BB_HOST_DAEMON_PORT: port({
    desc: "Port for the host-daemon local API",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
  BB_DEV_REPLAY_CAPTURE: bool({
    desc: "When true, the daemon records live provider traffic as replay captures (development only)",
    default: false,
  }),
});

export const hostDaemonConfig = rawHostDaemonConfig;
