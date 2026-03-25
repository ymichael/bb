import { envsafe, port, url } from "envsafe";
import { commonConfig } from "./common.js";

export { commonConfig };

export const hostDaemonConfig = envsafe({
  BB_SERVER_URL: url({
    desc: "URL of the bb server this daemon connects to",
    default: "http://localhost:3000",
    devDefault: "http://localhost:3000",
  }),
  BB_HOST_DAEMON_PORT: port({
    desc: "Port for the host-daemon local API",
    default: 3001,
    devDefault: 3001,
  }),
});
