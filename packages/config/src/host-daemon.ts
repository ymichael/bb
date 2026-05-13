import { bool, envsafe, port, str, url } from "envsafe";
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
  BB_HOST_DAEMON_PORT: port({
    desc: "Port for the host-daemon local API",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
  BB_DEV_APP_PORT: port({
    desc: "Vite port for the BB app frontend; allowed as a CORS origin for the daemon's local API.",
    default: DEFAULTS.appPort.dev,
    devDefault: DEFAULTS.appPort.dev,
  }),
  BB_APP_URL: str({
    desc: "Public app origin (e.g. https://app.example.com) — allowed as a CORS origin for the daemon's local API when the frontend is served from a non-localhost domain.",
    default: "",
    allowEmpty: true,
  }),
  BB_DEV_REPLAY_CAPTURE: bool({
    desc: "When true, the daemon records live provider traffic as replay captures (development only)",
    default: false,
  }),
});

export const hostDaemonConfig = {
  ...rawHostDaemonConfig,
  BB_APP_URL: validateOptionalUrl("BB_APP_URL", rawHostDaemonConfig.BB_APP_URL),
};
