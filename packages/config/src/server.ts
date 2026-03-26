import { envsafe, port, str } from "envsafe";
import { join } from "node:path";
import { commonConfig } from "./common.js";

export { commonConfig };

export const serverConfig = envsafe({
  BB_SERVER_PORT: port({
    desc: "HTTP port for the server",
    default: 3000,
    devDefault: 3000,
  }),
  BB_DATABASE_URL: str({
    desc: "SQLite database path. Defaults to $BB_DATA_DIR/bb.db",
    default: join(commonConfig.BB_DATA_DIR, "bb.db"),
  }),
  BB_E2B_API_KEY: str({
    desc: "E2B API key for ephemeral sandbox provisioning (optional)",
    default: "",
    allowEmpty: true,
  }),
  BB_E2B_TEMPLATE: str({
    desc: "E2B sandbox template ID (optional)",
    default: "",
    allowEmpty: true,
  }),
});
