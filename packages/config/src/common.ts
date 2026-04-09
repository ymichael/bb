import { homedir } from "node:os";
import { join } from "node:path";
import { envsafe, str } from "envsafe";
import { dataDir } from "./data-dir.js";
import { DEFAULTS } from "./defaults.js";

export const commonConfig = envsafe({
  BB_LOG_FORMAT: str({
    desc: "Log output format: json for structured logs, pretty for human-readable",
    default: DEFAULTS.logFormat.prod,
    devDefault: DEFAULTS.logFormat.dev,
    choices: ["json", "pretty"],
  }),
  BB_DATA_DIR: dataDir({
    desc: "Root directory for all bb data (db, logs, host-id, etc.)",
    default: join(homedir(), DEFAULTS.dataDir.prod),
    devDefault: join(homedir(), DEFAULTS.dataDir.dev),
  }),
  BB_LOG_LEVEL: str({
    desc: "Log level: trace, debug, info, warn, error, fatal",
    default: DEFAULTS.logLevel.prod,
    devDefault: DEFAULTS.logLevel.dev,
    choices: ["trace", "debug", "info", "warn", "error", "fatal"],
  }),
});
