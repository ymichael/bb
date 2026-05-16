import { envsafe, port, str } from "envsafe";
import { commonConfig } from "./common.js";
import { databaseConfig } from "./database.js";
import { DEFAULTS } from "./defaults.js";
import { featureFlags } from "./feature-flags.js";
import { validateInferenceModel } from "./inference-model.js";
import { validateOptionalUrl } from "./public-url.js";
import { serverPortConfig } from "./server-port.js";

export { commonConfig };

const rawServerConfig = envsafe({
  BB_HOST_DAEMON_PORT: port({
    desc: "Port the host daemon listens on for local API requests",
    default: DEFAULTS.hostDaemonPort.prod,
    devDefault: DEFAULTS.hostDaemonPort.dev,
  }),
  BB_APP_URL: str({
    desc: "Human-facing app/server base URL used for generated links and allowed browser origins. Does not control which host or port the server binds to.",
    default: "",
    allowEmpty: true,
  }),
  BB_EXTERNAL_URL: str({
    desc: "Internet-facing HTTPS base URL used for generated public links. Does not control which host or port the server binds to.",
    default: "",
    allowEmpty: true,
  }),
  BB_INFERENCE_MODEL: str({
    desc: "Inference model used for server-side completions in provider/model format",
    default: DEFAULTS.inferenceModel,
    devDefault: DEFAULTS.inferenceModel,
  }),
  OPENAI_API_KEY: str({
    desc: "OpenAI API key used for voice transcription and OpenAI-backed inference (optional)",
    default: "",
    allowEmpty: true,
    devDefault: "",
  }),
});

export const serverConfig = {
  ...databaseConfig,
  ...rawServerConfig,
  ...serverPortConfig,
  featureFlags,
  BB_APP_URL: validateOptionalUrl("BB_APP_URL", rawServerConfig.BB_APP_URL),
  BB_EXTERNAL_URL: validateOptionalUrl(
    "BB_EXTERNAL_URL",
    rawServerConfig.BB_EXTERNAL_URL,
  ),
  BB_INFERENCE_MODEL: validateInferenceModel(
    rawServerConfig.BB_INFERENCE_MODEL,
  ),
};
