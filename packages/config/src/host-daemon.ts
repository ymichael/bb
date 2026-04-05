import { envsafe, port, str, url } from "envsafe";
import { commonConfig } from "./common.js";
import { DEFAULTS } from "./defaults.js";
import { validateOptionalUrl } from "./public-url.js";

export { commonConfig };

const rawHostDaemonConfig = envsafe({
  BB_SERVER_URL: url({
    desc: "URL of the bb server this daemon connects to",
    default: DEFAULTS.serverUrl.prod,
    devDefault: DEFAULTS.serverUrl.dev,
  }),
  BB_PUBLIC_URL: str({
    desc: "Public URL sandboxes can use to reach the server",
    default: "",
    allowEmpty: true,
  }),
  BB_HOST_DAEMON_PORT: port({
    desc: "Port for the host-daemon local API",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
});

export const hostDaemonConfig = {
  ...rawHostDaemonConfig,
  BB_PUBLIC_URL: validateOptionalUrl("BB_PUBLIC_URL", rawHostDaemonConfig.BB_PUBLIC_URL),
};
