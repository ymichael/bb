import { homedir } from "node:os";
import { join } from "node:path";
import { envsafe, str } from "envsafe";
import { dataDir } from "./data-dir.js";
import { DEFAULTS } from "./defaults.js";
import { LOG_LEVEL_VALUES } from "./log-level.js";

export const commonConfig = envsafe({
  BB_DATA_DIR: dataDir({
    desc: "Root directory for all bb data (db, logs, host-id, etc.)",
    default: join(homedir(), DEFAULTS.dataDir.prod),
    devDefault: join(homedir(), DEFAULTS.dataDir.dev),
  }),
  BB_LOG_LEVEL: str({
    desc: "Log level: trace, debug, info, warn, error, fatal",
    default: DEFAULTS.logLevel.prod,
    devDefault: DEFAULTS.logLevel.dev,
    choices: LOG_LEVEL_VALUES,
  }),
});
